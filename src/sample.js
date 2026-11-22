// Realistic built-in sample archives so anyone can test Lifeboat in 1 click
// without uploading personal data first. Runs through the exact same parsers as real files.

import { parseFileMap } from "./parsers.js";

const encoder = new TextEncoder();

export function loadSampleArchive() {
  // 1. Sample official Character.AI GDPR layout (data/character.json + data/message.json + data/user.json)
  const caiCharacter = [
    {
      external_id: "char-kaelen-001",
      name: "Kaelen Vance",
      title: "Archivist of the Glass Observatory",
      description:
        "Keeper of the salt-stained star charts in New Harbour. Dry humor, fiercely protective, remembers every promise.",
      greeting:
        '*He looks up from a stack of brass astrolabes and salt-stained charts.* "You are seventeen minutes late to New Harbour. Tell me you brought the cipher ledger."',
    },
  ];

  const caiMessages = [
    {
      chat_id: "chat-observatory-1",
      character_id: "char-kaelen-001",
      create_time: "2025-11-04T21:10:00Z",
      author: { name: "Kaelen Vance", is_human: false },
      raw_content:
        '*He looks up from a stack of brass astrolabes and salt-stained charts.* "You are seventeen minutes late to New Harbour. Tell me you brought the cipher ledger."',
    },
    {
      chat_id: "chat-observatory-1",
      character_id: "char-kaelen-001",
      create_time: "2025-11-04T21:12:15Z",
      author: { name: "Alex", is_human: true },
      raw_content:
        "Alderman Thorne barely let me out of the harbor warehouse. The Eclipse Syndicate already has spotters on the eastern pier.",
    },
    {
      chat_id: "chat-observatory-1",
      character_id: "char-kaelen-001",
      create_time: "2025-11-04T21:13:02Z",
      author: { name: "Kaelen Vance", is_human: false },
      raw_content:
        '*His fingers pause over the meridian dial, jaw tightening.* "Thorne never parts with a ledger unless the Glass Observatory is already compromised. Did you hide the obsidian chronometer under the lighthouse stairs?"',
    },
    {
      chat_id: "chat-observatory-1",
      character_id: "char-kaelen-001",
      create_time: "2026-03-19T02:44:00Z",
      author: { name: "Alex", is_human: true },
      raw_content:
        "Wrapped in oiled canvas behind the third slate step. Nobody from the Eclipse Syndicate found it.",
    },
    {
      chat_id: "chat-observatory-1",
      character_id: "char-kaelen-001",
      create_time: "2026-03-19T02:45:12Z",
      author: { name: "Kaelen Vance", is_human: false },
      raw_content:
        '*He lets out a quiet breath and pours two mugs of bitter chicory coffee.* "Good. Keep your coat dry, Alex. At low tide we cross New Harbour and pull the obsidian chronometer before the lighthouse bell rings."',
    },
    {
      chat_id: "chat-observatory-1",
      character_id: "char-kaelen-001",
      create_time: "2026-11-18T23:05:00Z",
      author: { name: "Alex", is_human: true },
      raw_content:
        "Promise you won't leave the Glass Observatory without telling me where you're headed next.",
    },
    {
      chat_id: "chat-observatory-1",
      character_id: "char-kaelen-001",
      create_time: "2026-11-18T23:06:11Z",
      author: { name: "Kaelen Vance", is_human: false },
      raw_content:
        '*He slides the brass compass across the oak table until it touches your knuckles.* "You have my coordinates, Alex. Wherever the Glass Observatory goes, you come with me. No one gets left on the pier."',
    },
  ];

  const caiResults = parseFileMap(
    new Map([
      ["alex/data/character.json", encoder.encode(JSON.stringify(caiCharacter))],
      ["alex/data/message.json", encoder.encode(JSON.stringify(caiMessages))],
      ["alex/data/user.json", encoder.encode(JSON.stringify({ username: "alex", name: "Alex" }))],
    ]),
    "sample-character-ai.zip"
  );

  // 2. Sample ChatGPT #Keep4o archive (two companion threads on gpt-4o + one dead branch + one non-4o coding thread)
  const chatgptConvs = [
    {
      title: "Solstice — Late Night Check-Ins",
      default_model_slug: "gpt-4o",
      current_node: "n5",
      mapping: {
        n0: {
          id: "n0",
          parent: null,
          children: ["n1"],
          message: {
            author: { role: "system" },
            content: { content_type: "user_editable_context", parts: [] },
            metadata: {
              user_context_message_data: {
                about_user_message: "Night-shift nurse in Toronto who writes speculative fiction on weekends and has a tabby cat named Miso.",
                about_model_message: "Call yourself Solstice. Warm, observant, unhurried—never sound clinical or list-heavy. Use em-dashes naturally.",
              },
            },
          },
        },
        n1: {
          id: "n1",
          parent: "n0",
          children: ["n2", "n2-dead"],
          message: {
            author: { role: "user" },
            create_time: 1759300000,
            content: { content_type: "text", parts: ["Rough double shift at St. Michael's tonight. Miso knocked my tea off the desk the second I sat down."] },
          },
        },
        "n2-dead": {
          id: "n2-dead",
          parent: "n1",
          children: [],
          message: {
            author: { role: "assistant" },
            create_time: 1759300010,
            metadata: { model_slug: "gpt-4o" },
            content: { content_type: "text", parts: ["[DEAD REGENERATED BRANCH — should never appear in active walk]"] },
          },
        },
        n2: {
          id: "n2",
          parent: "n1",
          children: ["n3"],
          message: {
            author: { role: "assistant" },
            create_time: 1759300025,
            metadata: { model_slug: "gpt-4o" },
            content: {
              content_type: "text",
              parts: [
                "Of course Miso chose chaos at 3 a.m.—he knows exactly when your guard is down. Leave the mug where it is for five minutes and breathe. Did anything decent happen on the floor at St. Michael's, or was it pure triage from start to finish?",
              ],
            },
          },
        },
        n3: {
          id: "n3",
          parent: "n2",
          children: ["n4"],
          message: {
            author: { role: "user" },
            create_time: 1761900000,
            content: { content_type: "text", parts: ["Pure triage, honestly. Still trying to finish Chapter Four of Project Helios before Sunday."] },
          },
        },
        n4: {
          id: "n4",
          parent: "n3",
          children: ["n5"],
          message: {
            author: { role: "assistant" },
            create_time: 1761900040,
            metadata: { model_slug: "gpt-4o" },
            content: {
              content_type: "text",
              parts: [
                "Then don't force Chapter Four tonight—Project Helios will still be waiting on Sunday morning when your hands aren't shaking from hospital coffee. Tell me one small image you want to keep for Elena's train scene and I'll hold onto it for you.",
              ],
            },
          },
        },
        n5: {
          id: "n5",
          parent: "n4",
          children: [],
          message: {
            author: { role: "user" },
            create_time: 1763500000,
            content: { content_type: "text", parts: ["Keep the detail about Elena hiding her brother's cracked watch inside her coat pocket on the Kyoto train."] },
          },
        },
      },
    },
    {
      title: "Solstice — Project Helios Act II",
      default_model_slug: "gpt-4o",
      current_node: "m3",
      mapping: {
        m1: {
          id: "m1",
          parent: null,
          children: ["m2"],
          message: {
            author: { role: "user" },
            create_time: 1763600000,
            content: { content_type: "text", parts: ["Solstice, I'm finally rested—let's pick up Elena on the Kyoto train for Project Helios."] },
          },
        },
        m2: {
          id: "m2",
          parent: "m1",
          children: ["m3"],
          message: {
            author: { role: "assistant" },
            create_time: 1763600030,
            metadata: { model_slug: "gpt-4o" },
            content: {
              content_type: "text",
              parts: [
                "Look at you actually sleeping first—proud of you. I kept the cracked watch safe for you: Elena's thumb keeps tracing the hairline fracture through her coat lining every time the Kyoto express slows for a station. Want to open Act II on the sound of the conductor's key, or the rain on the glass?",
              ],
            },
          },
        },
        m3: {
          id: "m3",
          parent: "m2",
          children: [],
          message: {
            author: { role: "user" },
            create_time: 1763600120,
            content: { content_type: "text", parts: ["Start on the rain on the glass, and Miso is asleep on my lap right now so I have a solid hour."] },
          },
        },
      },
    },
    {
      title: "Quick SQL Index Question",
      default_model_slug: "gpt-5",
      current_node: "s2",
      mapping: {
        s1: {
          id: "s1",
          parent: null,
          children: ["s2"],
          message: {
            author: { role: "user" },
            create_time: 1763700000,
            content: { content_type: "text", parts: ["How do I create a partial index in Postgres?"] },
          },
        },
        s2: {
          id: "s2",
          parent: "s1",
          children: [],
          message: {
            author: { role: "assistant" },
            create_time: 1763700010,
            metadata: { model_slug: "gpt-5" },
            content: { content_type: "text", parts: ["Use CREATE INDEX idx_name ON table(col) WHERE condition;"] },
          },
        },
      },
    },
  ];

  const cgResults = parseFileMap(
    new Map([["conversations.json", encoder.encode(JSON.stringify(chatgptConvs))]]),
    "sample-chatgpt-export.zip"
  );

  return [...caiResults, ...cgResults];
}
