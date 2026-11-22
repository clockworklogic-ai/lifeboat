package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	_ "image/jpeg"
	"image/png"
)

var pngSig = []byte{137, 80, 78, 71, 13, 10, 26, 10}

// EncodeTavernPNG generates a valid 400x600 portrait PNG (or wraps customAvatarBytes) with both Tavern V2 ("chara") and V3 ("ccv3") tEXt chunks embedded.
func EncodeTavernPNG(card TavernCardV2, customAvatarBytes ...[]byte) ([]byte, error) {
	if card.Spec == "" {
		card.Spec = "chara_card_v2"
		card.SpecVersion = "2.0"
	}
	v2Bytes, err := json.Marshal(card)
	if err != nil {
		return nil, err
	}
	b64V2 := base64.StdEncoding.EncodeToString(v2Bytes)

	v3Card := map[string]any{
		"spec":         "chara_card_v3",
		"spec_version": "3.0",
		"data":         card.Data,
	}
	v3Bytes, err := json.Marshal(v3Card)
	if err != nil {
		return nil, err
	}
	b64V3 := base64.StdEncoding.EncodeToString(v3Bytes)

	var basePNG []byte
	if len(customAvatarBytes) > 0 && len(customAvatarBytes[0]) > 0 {
		basePNG, err = normalizeToCleanPNG(customAvatarBytes[0])
		if err != nil {
			basePNG, err = renderAvatarPNG(card.Data.Name)
			if err != nil {
				return nil, err
			}
		}
	} else {
		basePNG, err = renderAvatarPNG(card.Data.Name)
		if err != nil {
			return nil, err
		}
	}

	withV2, err := injectPNGTextChunk(basePNG, "chara", b64V2)
	if err != nil {
		return nil, err
	}
	return injectPNGTextChunk(withV2, "ccv3", b64V3)
}

func normalizeToCleanPNG(raw []byte) ([]byte, error) {
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// DecodeTavernPNG extracts and decodes the "chara" (V2) or "ccv3" (V3) tEXt chunk from a Tavern PNG file.
func DecodeTavernPNG(pngBytes []byte) (*TavernCardV2, error) {
	if len(pngBytes) < 8 || !bytes.Equal(pngBytes[:8], pngSig) {
		return nil, fmt.Errorf("not a valid PNG file")
	}
	offset := 8
	var foundB64 string
	for offset+8 <= len(pngBytes) {
		length := int(binary.BigEndian.Uint32(pngBytes[offset : offset+4]))
		chunkType := string(pngBytes[offset+4 : offset+8])
		dataStart := offset + 8
		dataEnd := dataStart + length
		if dataEnd+4 > len(pngBytes) || length < 0 {
			break
		}
		if chunkType == "tEXt" {
			chunkData := pngBytes[dataStart:dataEnd]
			nullIdx := bytes.IndexByte(chunkData, 0)
			if nullIdx > 0 {
				keyword := string(chunkData[:nullIdx])
				if keyword == "chara" {
					foundB64 = string(chunkData[nullIdx+1:])
					break
				}
				if keyword == "ccv3" && foundB64 == "" {
					foundB64 = string(chunkData[nullIdx+1:])
				}
			}
		}
		offset = dataEnd + 4
	}
	if foundB64 == "" {
		return nil, fmt.Errorf("no 'chara' or 'ccv3' tEXt chunk found in PNG")
	}
	rawJSON, err := base64.StdEncoding.DecodeString(foundB64)
	if err != nil {
		return nil, fmt.Errorf("failed to base64-decode PNG chunk: %w", err)
	}
	var card TavernCardV2
	if err := json.Unmarshal(rawJSON, &card); err != nil {
		return nil, fmt.Errorf("failed to unmarshal Tavern JSON: %w", err)
	}
	card.Spec = "chara_card_v2"
	card.SpecVersion = "2.0"
	return &card, nil
}

func injectPNGTextChunk(pngBytes []byte, keyword, text string) ([]byte, error) {
	if len(pngBytes) < 8 || !bytes.Equal(pngBytes[:8], pngSig) {
		return nil, fmt.Errorf("invalid base PNG")
	}

	var payload bytes.Buffer
	payload.WriteString(keyword)
	payload.WriteByte(0)
	payload.WriteString(text)
	data := payload.Bytes()

	var chunk bytes.Buffer
	if err := binary.Write(&chunk, binary.BigEndian, uint32(len(data))); err != nil {
		return nil, err
	}
	chunk.WriteString("tEXt")
	chunk.Write(data)

	crc := crc32.NewIEEE()
	crc.Write([]byte("tEXt"))
	crc.Write(data)
	if err := binary.Write(&chunk, binary.BigEndian, crc.Sum32()); err != nil {
		return nil, err
	}

	offset := 8
	for offset+8 <= len(pngBytes) {
		length := int(binary.BigEndian.Uint32(pngBytes[offset : offset+4]))
		chunkType := string(pngBytes[offset+4 : offset+8])
		if chunkType == "IEND" {
			var out bytes.Buffer
			out.Write(pngBytes[:offset])
			out.Write(chunk.Bytes())
			out.Write(pngBytes[offset:])
			return out.Bytes(), nil
		}
		offset += 8 + length + 4
	}
	return nil, fmt.Errorf("IEND chunk not found in PNG")
}

func renderAvatarPNG(name string) ([]byte, error) {
	const w, h = 400, 600
	img := image.NewRGBA(image.Rect(0, 0, w, h))

	var seed uint32 = 2166136261
	for i := 0; i < len(name); i++ {
		seed ^= uint32(name[i])
		seed *= 16777619
	}

	r1 := uint8(24 + (seed & 0x3F))
	g1 := uint8(28 + ((seed >> 6) & 0x3F))
	b1 := uint8(48 + ((seed >> 12) & 0x5F))

	r2 := uint8(80 + ((seed >> 18) & 0x5F))
	g2 := uint8(45 + ((seed >> 24) & 0x4F))
	b2 := uint8(95 + ((seed >> 10) & 0x5F))

	for y := 0; y < h; y++ {
		t := float64(y) / float64(h-1)
		cr := uint8(float64(r1)*(1-t) + float64(r2)*t)
		cg := uint8(float64(g1)*(1-t) + float64(g2)*t)
		cb := uint8(float64(b1)*(1-t) + float64(b2)*t)
		for x := 0; x < w; x++ {
			if x == 16 || x == w-17 || y == 16 || y == h-17 {
				img.SetRGBA(x, y, color.RGBA{R: 210, G: 190, B: 150, A: 255})
			} else {
				img.SetRGBA(x, y, color.RGBA{R: cr, G: cg, B: cb, A: 255})
			}
		}
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
