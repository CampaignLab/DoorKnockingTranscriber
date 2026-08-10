---
version: 1
slug: "index-html"
primary_target: "index.html"
related_targets: ["src/ui/record-view.ts","src/ui/onboarding-view.ts","src/ui/sessions-view.ts","src/ui/session-detail-view.ts","src/ui/share-view.ts"]
---

# Surface brief — whole app (record, onboarding, sessions, detail, share)

## Scope & mode
Entire app, every route. Mode: Operate — the visitor completes a task (record conversations, share the day's notes). Scanability, calm, and familiar affordance outrank expression.

## Audience, job, action
Canvassers 60–75 on their own phones, outdoors, one-handed, often low signal, varying eyesight and dexterity. Job: capture each doorstep conversation and hand the day's notes to the campaign. Primary action: one red Record button. Secondary: "See my notes", "Finish & share".

## Direction (chosen)
The Desk Dictaphone (assigned by roll 3b537363, candidate 5/7; user unattended — delegated pick recorded). The app is the handheld recorder this audience used for decades: one big red key, a counter, words appearing as you speak. Light warm paper ground (#faf7f2), near-black ink, base type 20px+, display counter in tabular numerals, red reserved for Record, quiet green for saved/ok. No dark mode, no badges/pills/nav chrome beyond one quiet text link.

## Radical simplification contract
Remove: privacy badge, status pills, tags, consent banner block, redaction counts, model names/sizes, bottom nav (replaced by one quiet "See my notes" text link on the record screen). Language: "Record" not "transcribe"; "notes" not "sessions/block" in user-facing copy; reassurance on load: "Everything stays on this phone. Nothing is uploaded." Onboarding reduced to: what it does, why it's safe, one "Get started" button, then a plain-English download screen ("Setting up your device… this happens once").

## Component grammar (from direction)
- Keys: large rounded rectangles/circles with soft drop shadow (offset + blur), physical press on :active (scale .97). Record key: 160px circle, red ring + red fill core, square stop glyph while recording.
- Type ramp: display counter 3rem tabular; headings 1.6rem/700; body 1.15–1.25rem; quiet helper text 1rem in warm gray (#57534e), never pure gray on color.
- Surfaces: white inset "paper window" for transcripts/notes preview, 16px radius, hairline warm border, no nested cards.
- States: recording = red ring pulses softly + timer runs + plain prompt "Speak their name and address first"; saved = green check line. Errors in plain sentences naming the fix.

## Constraints
Zero network after model cache (CSP strict); English only; audio never retained; HTTPS required for mic; must work one-handed on 360px-wide phones; contrast ≥4.5:1 body / ≥3:1 large; reduced-motion: no pulse.

## Unresolved
None blocking. Data-controller wording deliberately absent from UI.
