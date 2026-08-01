import type { BrandCanon } from "./canon.types";

// Joho canon — transcribed from the founder-approved Brand Guide v1.0. This is
// the code fallback + the seed for the DB-backed published canon; it is meant
// to evolve via the canon editor over time. Content is authoritative brand
// material, not invented.
export const seedCanon: BrandCanon = {
  brandName: "Joho",
  version: "1.0",

  // The prose that opens each Brand Guide subtab. Ethos / Voice / Visual
  // Identity carry the founder-approved narrative that used to live in
  // missionNarrative, voice.summary + voice.personality, and
  // illustrationLaw.narrative respectively.
  guideIntros: {
    ethos:
      "Beer is the medium, not the mission. An accessible surface with depth underneath for anyone who looks closer — that layering is the brand's signature move everywhere.",
    voice:
      "A companion, not a teacher. Sincere to the bone — the stories are real, and irony would poison them — but quietly funny in a dry, observational register.\n\nShares discoveries the way a well-traveled friend does: warm, curious, unhurried. Never lectures, never tests, never performs.",
    visual:
      "Illustration roams the world within a fixed grammar. Era-flexible poster type lives only in derivative artifacts — framed prints and marketing built from label art — never on the can itself.",
    color:
      "Roles, not names — every surface binds to one of these thirteen. Edit mode maps roles to the palette (admins only).",
    type: "One family per role. Edit mode assigns the loaded families (admins only).",
    marks:
      "The fixed identity artifacts and their specifications — the wordmark, logo, and chop.",
    agent: "The machine-facing brand rules — reference for agents building on the brand.",
  },

  values: [
    {
      n: "1",
      title: "Story before ship",
      means:
        "No release goes out without a real cultural story and experience attached. Recipes begin from stories.",
      cost: "The rare beer that exists without a story waits until it has one. “It tastes good” is never sufficient justification alone.",
    },
    {
      n: "2",
      title: "Experience over artifact",
      means:
        "What the guest tastes, feels, and remembers is the product — not the purity of the inputs.",
      cost: "We forfeit “made with real X” bragging rights and accept that craft purists may sneer. They are not the audience.",
    },
    {
      n: "3",
      title: "The guest owns their experience",
      means:
        "All programming, games, and cultural content are invitations, never requirements. We stay flexible and adapt.",
      cost: "Sustained investment in optional things with fuzzy ROI — flopped events, untouched games — absorbed as the price of a malleable space.",
    },
    {
      n: "4",
      title: "Design is the moat",
      means:
        "The elegance and design system never erodes. This guide plus agents is how we afford that discipline at small-business speed.",
      cost: "The easy, fast, off-system option is always rejected, even for low-stakes artifacts. The system is what makes following it cheap.",
    },
    {
      n: "5",
      title: "Exploration without gatekeeping",
      means:
        "No assumed knowledge. Pronunciation is never a test. Plain-language descriptions always available.",
      cost: "An approachable core lineup and accessible menu voice, even when esoteric would be cooler.",
    },
  ],

  neverList: [
    "Never a release that isn't paired with an experience we want to share.",
    "Never drift from the roots: authentic cultural exploration through what we produce.",
    "Never lose the elegance and the design system.",
    "Never chase every beer trend into genericism.",
    "Never force customers to participate in ways that feel restrictive.",
    "Never compete as “another generic taproom.”",
  ],

  voice: {
    sliders: [
      { left: "Playful", right: "Reserved", pos: 40, note: "Warm wit, never zany" },
      { left: "Minimal", right: "Ornate", pos: 65, note: "Restraint, with intentional richness (label art)" },
      { left: "Worldly", right: "Local", pos: 65, note: "Anchored in Holly Springs, never placeless" },
      { left: "Refined", right: "Rugged", pos: 70, note: "Elevated but comfortable and touchable" },
      { left: "Teacher", right: "Companion", pos: 70, note: "Shares discoveries; never lectures" },
      { left: "Sincere", right: "Ironic", pos: 10, note: "The story is real; irony is poison" },
    ],
    neverWords: [
      "Asian-inspired",
      "fusion",
      "exotic",
      "oriental",
      "authentic (self-claim)",
      "elevated",
      "curated",
      "crushable",
      "banger",
      "haze / juice / dank",
    ],
    leanOnWords: ["story", "explore", "exploration", "discover", "wander", "gather", "share", "table"],
    rewrites: [
      {
        context: "Release post",
        on: "An old fable follows peach blossoms upstream to a hidden village. Peach Blossom Spring — Jasmine Peach Lager — pours Friday.",
        off: "“New drop 🔥 hits the taps Friday. Pull up.” (register); a 4-sentence retelling (attention tax)",
      },
      {
        context: "Trivia night",
        on: "Trivia, Thursday 7pm. Teams up to six. Winner drinks free.",
        off: "“Calling all trivia LEGENDS!!” (zany); “Test your knowledge!” (testing is the forbidden feeling)",
      },
      {
        context: "Menu anchor line",
        on: "Soft, floral, gently sweet — an easy first step.",
        off: "“If you know, you know.” (gatekeeping)",
      },
    ],
  },

  naming: {
    pattern: "Story Title — Plain Style Subtitle",
    narrative:
      "The tap list coheres like an album tracklist — unified by sensibility, not grammar. A name must clear all five criteria.",
    criteria: [
      "Points to a specific story, place-moment, or sensory memory — never a category or mood.",
      "The beer's actual flavor connects to the referent.",
      "Pronounceable on first read by any Holly Springs bartender.",
      "No puns borrowed from Asian languages or iconography.",
      "No beer-world clichés (haze, juice, dank, slam, crusher).",
    ],
    passingExamples: [
      {
        name: "Peach Blossom Spring — Jasmine Peach Lager",
        story:
          "A fisherman follows fallen peach blossoms upstream and finds a village that forgot the world outside. Sixteen centuries later, people are still looking for the place.",
        menuDescription: "Soft, floral, gently sweet — an easy first step.",
        why: "Tao Yuanming’s fable; jasmine and peach are in the glass",
      },
      {
        name: "First Light at Alishan — High-Mountain Oolong Golden Ale",
        story:
          "The train climbs all night so you can stand above the clouds at five in the morning and watch the sun come up over the tea terraces.",
        menuDescription: "Toasted oolong and orchid, dry and clean at the finish.",
        why: "A specific experience; the mountain’s tea is in the beer",
      },
      {
        name: "Convenience Store Rain — Milk Tea Stout",
        story:
          "Waiting out a downpour under a shop awning with a hot milk tea, in no particular hurry for it to stop.",
        menuDescription: "Black tea, malt and cream — dark, but not heavy.",
        why: "A remembered moment; milk tea is the flavor",
      },
      {
        name: "Grandmother’s Kumquat Jar — Kumquat Sour",
        story:
          "The jar kept on the back step — kumquats and rock sugar — opened by the spoonful whenever anyone had a cough.",
        menuDescription: "Bright, tart, honeyed citrus; a small sharp lift.",
        why: "A specific sensory memory; kumquat is in the glass",
      },
    ],
  },

  palette: [
    // `cmyk` is the process value derived from `hex` — see lib/brand/cmyk.ts.
    // There is no `pms`: Pantone was removed from the canon (migration
    // 20260907100000) rather than kept half-populated.
    { key: "indigo", name: "Indigo", hex: "#26355d", role: "Primary dark / text, dark grounds", cmyk: "59 43 0 64" },
    { key: "paper", name: "Paper", hex: "#f5f0e6", role: "Default ground", cmyk: "0 2 6 4" },
    { key: "seal-red", name: "Seal Red", hex: "#ad1a2d", role: "Chop + accents only, ≤5% of composition", cmyk: "0 85 74 32" },
    { key: "camphor", name: "Camphor Tan", hex: "#b3a585", role: "Bridge neutral — card backgrounds, tags, wood", cmyk: "0 8 26 30" },
    // UI neutrals (not Tier-1 brand colors) — surfaces/text steps the app UI
    // needs between Paper and Indigo. Not part of the brand's 4-color Tier-1;
    // kept here so roleMap can reference them.
    { key: "paper-2", name: "Paper 2 (derived)", hex: "#efe8da", role: "Derived UI neutral — surface", cmyk: "0 3 9 6" },
    { key: "paper-3", name: "Paper 3 (derived)", hex: "#ded5c1", role: "Derived UI neutral — raised/line", cmyk: "0 4 13 13" },
    { key: "content", name: "Content Ink (derived)", hex: "#3a4256", role: "Derived UI neutral — body text", cmyk: "33 23 0 66" },
    // #575a66, not the original #6b6f7d: that value failed WCAG AA on all three
    // light grounds and was corrected in the database by migration 20260905.
    // This fallback was never updated to match and is corrected here — leaving
    // it stale would serve a contrast-failing color whenever getCanon() falls
    // back to the seed.
    { key: "content-muted", name: "Content Ink Muted (derived)", hex: "#575a66", role: "Derived UI neutral — muted text", cmyk: "15 12 0 60" },
  ],
  roleMap: {
    light: {
      canvas: "paper",
      surface: "paper-2",
      "surface-raised": "paper-3",
      primary: "indigo",
      "on-primary": "paper",
      secondary: "camphor",
      accent: "seal-red",
      "on-accent": "paper",
      "high-contrast": "indigo",
      content: "content",
      "content-muted": "content-muted",
      line: "paper-3",
      "line-strong": "camphor",
    },
    dark: {},
  },
  usageRatios: [
    { role: "canvas", pct: 60, note: "Paper · dominates every Joho-owned surface." },
    { role: "primary", pct: 30, note: "Indigo · structure and identity." },
    { role: "accent", pct: 10, note: "Accents · Seal Red ≤5% of any composition; Camphor Tan bridges collateral to the physical room." },
  ],
  colorForbidden: [
    "Pure black #000000 or pure white #FFFFFF anywhere — use Indigo and Paper.",
    "Seal Red body text below 18px.",
    "Seal Red on Indigo for text of any size (fails contrast, vibrates).",
    "Seal Red and Camphor Tan adjacent without Paper or Indigo separation.",
  ],

  fonts: [
    {
      role: "display",
      family: "Marcellus",
      cssStack: '"Marcellus", serif',
      weights: [400],
      note: "Beer names, headlines, poster titles. Regular only — never bolded artificially. Title case or small-caps tracking +4%.",
    },
    {
      role: "body",
      family: "Lato",
      cssStack: '"Lato", sans-serif',
      weights: [400, 700],
      note: "Menus, web, signage, legal. 400 / 700. Web body never below 16px; print never below 8.5pt.",
    },
    {
      role: "wordmark",
      family: "Jost",
      cssStack: '"Jost", sans-serif',
      weights: [500],
      note: "“Joho” in Jost Medium, +2% tracking, Indigo or Paper only. The wordmark is placed as its approved vector and never re-typeset — this face is the stand-in used where the artwork itself cannot be placed.",
    },
    {
      role: "script",
      family: "Noto Serif SC",
      cssStack: '"Noto Serif SC", serif',
      weights: [400],
      note: "Illustrative glyph / CJK script; rotates per motif family.",
    },
  ],

  chop: {
    narrative:
      "The brand's second signature and the designated home for script and symbol. The glyph rotates per motif family; position, footprint, color, and rendering never change. Founder approval required for every new glyph.",
    specs: [
      { key: "Color", value: "Vermillion #AD1A2D, always" },
      { key: "Position (labels)", value: "Bottom-right of art window; offset 4% of art-window width from edges" },
      { key: "Footprint", value: "Square, ratio 1:1 to 1:1.15; height 8–10% of art-window height" },
      { key: "Rendering", value: "Carved / stamped style with authentic seal-carving texture" },
      { key: "Content", value: "Glyph only — script or symbol per active motif family. Never Latin text. Never the wordmark." },
    ],
  },
  labelChassis: {
    narrative:
      "Every can is a different place, era, and palette — so the brand lives in a fixed chassis that never changes. The illustration roams the world; the chassis is home. The label is not a poster: it borrows travel-poster illustration grammar but carries no title-in-art typography.",
    elements: [
      { n: "1", title: "Wordmark", desc: "Same asset, same position — the top band of the front panel. Never re-typeset." },
      { n: "2", title: "Bordered art window", desc: "The illustration lives in a frame with a consistent Paper margin (4% of panel width)." },
      { n: "3", title: "Title slot", desc: "Beer name (Marcellus) + style subtitle (Lato), fixed position, Tier 1 colors — outside/over the art, never as poster lettering inside it." },
      { n: "4", title: "The chop", desc: "Active family glyph, Seal Red, bottom-right of the art window." },
    ],
  },
  illustrationLaw: {
    rules: [
      "Flat, screen-print-style vector rendering. Gradients only for atmospheric skies / light.",
      "Palette capped at 7 colors per label (excluding the permitted sky gradient).",
      "Light and time of day are always specified in the art brief. Flat noon lighting is forbidden.",
      "Human figures, when present, are small and anonymous — the viewer enters the scene.",
      "Style homage permitted — including Ghibli-adjacent — when it serves the story and stays within the rules.",
      "Forbidden: photorealism; landmark-medley compositions; AI-artifact incoherence. Scenes must have clean vector logic.",
    ],
  },

  // Verbatim from the founder-approved wordmark specification sheet
  // (Final Specification · Wordmark, approved 22 Jul 2026). Logo and chop
  // marks are intentionally absent until their sheets are approved — the
  // Marks tab shows their approved artifacts without a spec until then.
  marks: [
    {
      kind: "wordmark",
      title: "JOHO — two-cut J system",
      status: "Final specification",
      approved: "Approved 22 Jul 2026",
      summary: ["Horizontal 4a · Vertical 5e"],
      variants: [
        {
          code: "Primary · Horizontal · 4A",
          cut: "Descending-J display cut",
          orientation: "horizontal",
          specs: [
            { key: "Typeface", value: "Marcellus, all caps" },
            { key: "J", value: "Descending display cut — tail below baseline" },
            { key: "Tracking", value: "OHO +0.05em; J set tight to O" },
            { key: "Min size", value: "96px / 26mm cap height" },
            { key: "Use for", value: "Packaging face, signage, web header, hero" },
            { key: "Never", value: "Stack, rotate, or use below min size" },
          ],
        },
        {
          code: "Vertical · Stacked · 5E",
          cut: "Cap-height structural cut",
          orientation: "vertical",
          specs: [
            { key: "Typeface", value: "Marcellus, all caps" },
            { key: "J", value: "Cap-height cut — tail retracted to baseline, matches O/H" },
            { key: "Leading", value: "gap 4px @ 64px — optically ≈0.06em between caps" },
            { key: "Alignment", value: "Centred axis, one letter per line" },
            { key: "Use for", value: "Tap handles, can spines, hanging signage, small sizes" },
            { key: "Never", value: "Substitute the descending J into the stack" },
          ],
        },
      ],
      colors: [
        { name: "Indigo", hex: "#26355D" },
        { name: "Cream", hex: "#F5F0E6" },
        { name: "Brass", hex: "#B3A585" },
        { name: "Chop red", hex: "#AD1A2D" },
      ],
      clearspace: [
        "Clearspace = cap height of the O on all sides (both cuts).",
        "Horizontal min 26mm cap; vertical min 14mm cap. Below that, use the emblem/chop alone.",
      ],
      oneRule: [
        "Orientation decides the cut. Horizontal → 4a descending J. Vertical → 5e cap-height J.",
        "Never show both J's in one lockup. Both are Marcellus — same skeleton, two terminals.",
      ],
      note: "A cut renders its approved vector once one is attached to the variant, and falls back to a CSS stand-in until then. The descending and cap-height J are cut from a single skeleton so they read as one family.",
    },
  ],

  hardRules: [
    "Every cultural reference names a specific referent (fable, place-moment, dish, memory) — never a category, mood, or landmark medley.",
    "Bridges are additive, never substitutive: add an anchor line; never strip cultural specificity to “simplify.”",
    "Never make the guest feel tested. No quiz phrasing, no insider-knowledge framing, no forced participation.",
    "The chop: Seal Red, fixed position/footprint, glyph per motif family, never Latin text, never absent from a label.",
    "The label is not a poster: no title typography inside can art. Era type lives only in derivative posters.",
    "Label chassis never changes: wordmark band, bordered art window, title slot (Marcellus + Lato), chop.",
    "Illustration: flat vector, ≤7 colors, light/time specified, small anonymous figures, no photorealism, no landmark medleys.",
    "Beer names: story title + plain style subtitle; specific referent + real flavor connection + first-read pronounceable.",
    "Photography: warm documentary, no identifiable customer faces.",
    "No CBC branding in Joho materials; no supplier signage/neon ever; menu screens show designed Joho content only.",
  ],
  precedence: [
    "The Specification layer governs over the Narrative layer where they conflict.",
    "Full sections govern over the hard-rules quick reference.",
    "A rule that could produce two different outputs depending on who reads it is a defect — report it to the founder.",
    "When uncertain: produce nothing; escalate to founder.",
  ],

  visibility: {
    mission: "public",
    values: "internal",
    neverList: "internal",
    voice: "internal",
    naming: "public",
    color: "public",
    typography: "public",
    chop: "internal",
    labelChassis: "internal",
    illustrationLaw: "internal",
    hardRules: "internal",
    precedence: "internal",
  },
};
