package main

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
)

var (
	errZipEncrypted     = errors.New("zip archive is password-protected (pass -password with your lowercase email)")
	errZipWrongPassword = errors.New("wrong zip password (for Character.AI exports use your lowercase account email)")
)

// zipCryptoState implements standard PKWARE ZipCrypto stream decryption (IEEE CRC32 table).
type zipCryptoState struct {
	k0, k1, k2 uint32
}

func newZipCrypto(password string) *zipCryptoState {
	s := &zipCryptoState{
		k0: 0x12345678,
		k1: 0x23456789,
		k2: 0x34567890,
	}
	for i := 0; i < len(password); i++ {
		s.update(password[i])
	}
	return s
}

func (s *zipCryptoState) update(c byte) {
	s.k0 = crc32UpdateByte(s.k0, c)
	s.k1 = (s.k1+(s.k0&0xff))*134775813 + 1
	s.k2 = crc32UpdateByte(s.k2, byte(s.k1>>24))
}

func (s *zipCryptoState) decryptByte() byte {
	t := uint16(s.k2) | 2
	return byte((t * (t ^ 1)) >> 8)
}

func (s *zipCryptoState) decryptBytes(dst, src []byte) {
	for i, b := range src {
		p := b ^ s.decryptByte()
		s.update(p)
		dst[i] = p
	}
}

func crc32UpdateByte(crc uint32, b byte) uint32 {
	return crc32.IEEETable[(crc^uint32(b))&0xff] ^ (crc >> 8)
}

func isZipEntryEncrypted(f *zip.File) bool {
	return f.Flags&0x1 != 0
}

// readZipEntry reads either an unencrypted zip entry or a PKWARE ZipCrypto encrypted entry.
func readZipEntry(f *zip.File, password string, limit int64) ([]byte, error) {
	if !isZipEntryEncrypted(f) {
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()
		return io.ReadAll(io.LimitReader(rc, limit))
	}
	if password == "" {
		return nil, errZipEncrypted
	}
	if f.Method == 99 {
		return nil, fmt.Errorf("winzip AES-encrypted entry %q requires the Lifeboat web app (supports AES-256 + ZipCrypto in-browser)", f.Name)
	}

	rawReader, err := f.OpenRaw()
	if err != nil {
		return nil, err
	}
	encData, err := io.ReadAll(io.LimitReader(rawReader, limit+12))
	if err != nil {
		return nil, err
	}
	if len(encData) < 12 {
		return nil, fmt.Errorf("truncated encrypted zip entry %q", f.Name)
	}

	st := newZipCrypto(password)
	hdr := make([]byte, 12)
	st.decryptBytes(hdr, encData[:12])

	// Verify PKWARE encryption check byte (CRC high byte, or ModTime high byte if data descriptor flag 0x8 is set)
	var expected byte
	if f.Flags&0x8 != 0 {
		expected = byte(f.ModifiedTime >> 8)
	} else {
		expected = byte(f.CRC32 >> 24)
	}
	if hdr[11] != expected {
		return nil, errZipWrongPassword
	}

	plain := make([]byte, len(encData)-12)
	st.decryptBytes(plain, encData[12:])

	var out []byte
	switch f.Method {
	case zip.Store:
		out = plain
	case zip.Deflate:
		fr := flate.NewReader(bytes.NewReader(plain))
		out, err = io.ReadAll(io.LimitReader(fr, limit))
		_ = fr.Close()
		if err != nil {
			return nil, errZipWrongPassword
		}
	default:
		return nil, fmt.Errorf("unsupported compression method %d in %q", f.Method, f.Name)
	}

	if f.CRC32 != 0 && crc32.ChecksumIEEE(out) != f.CRC32 {
		return nil, errZipWrongPassword
	}
	return out, nil
}

// writeZipCryptoTestArchive creates a valid PKWARE ZipCrypto encrypted zip (used by unit tests).
func writeZipCryptoTestArchive(entries map[string][]byte, password string) ([]byte, error) {
	var buf bytes.Buffer
	type cdEntry struct {
		name     string
		crc      uint32
		compSize uint32
		uncomp   uint32
		localOff uint32
	}
	var cds []cdEntry

	for name, data := range entries {
		localOff := uint32(buf.Len())
		sum := crc32.ChecksumIEEE(data)

		st := newZipCrypto(password)
		// 12-byte deterministic encryption header ending in high byte of CRC32
		hdr := [12]byte{0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, byte(sum >> 24)}
		enc := make([]byte, 12+len(data))
		for i, b := range hdr {
			enc[i] = b ^ st.decryptByte()
			st.update(b)
		}
		for i, b := range data {
			enc[12+i] = b ^ st.decryptByte()
			st.update(b)
		}

		// Local file header (method 0 = Store, flag 0x1 = encrypted)
		_ = binary.Write(&buf, binary.LittleEndian, uint32(0x04034b50))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(20))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0x0001))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
		_ = binary.Write(&buf, binary.LittleEndian, sum)
		_ = binary.Write(&buf, binary.LittleEndian, uint32(len(enc)))
		_ = binary.Write(&buf, binary.LittleEndian, uint32(len(data)))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(len(name)))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
		buf.WriteString(name)
		buf.Write(enc)

		cds = append(cds, cdEntry{
			name:     name,
			crc:      sum,
			compSize: uint32(len(enc)),
			uncomp:   uint32(len(data)),
			localOff: localOff,
		})
	}

	cdStart := uint32(buf.Len())
	for _, c := range cds {
		_ = binary.Write(&buf, binary.LittleEndian, uint32(0x02014b50))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(20))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(20))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0x0001))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
		_ = binary.Write(&buf, binary.LittleEndian, c.crc)
		_ = binary.Write(&buf, binary.LittleEndian, c.compSize)
		_ = binary.Write(&buf, binary.LittleEndian, c.uncomp)
		_ = binary.Write(&buf, binary.LittleEndian, uint16(len(c.name)))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
		_ = binary.Write(&buf, binary.LittleEndian, uint32(0))
		_ = binary.Write(&buf, binary.LittleEndian, c.localOff)
		buf.WriteString(c.name)
	}
	cdSize := uint32(buf.Len()) - cdStart

	// End of central directory
	_ = binary.Write(&buf, binary.LittleEndian, uint32(0x06054b50))
	_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
	_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
	_ = binary.Write(&buf, binary.LittleEndian, uint16(len(cds)))
	_ = binary.Write(&buf, binary.LittleEndian, uint16(len(cds)))
	_ = binary.Write(&buf, binary.LittleEndian, cdSize)
	_ = binary.Write(&buf, binary.LittleEndian, cdStart)
	_ = binary.Write(&buf, binary.LittleEndian, uint16(0))

	return buf.Bytes(), nil
}
