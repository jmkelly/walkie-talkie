# Walkie Talkie — design system

Read `PRODUCT.md` first. This is the miniature system: tokens, component rules, and one example of each. New screens reuse these values instead of inventing new ones.

## Tokens

### Color

| Token | Value | Job |
| --- | --- | --- |
| `--room-bg` | `#080706` | The dark room around the console. |
| `--console` | `#0f0d0b` | The console shell and chat surface. |
| `--rail` | `#12100d` | The status and transmit rail. |
| `--panel` | `#17140f` | Message bubbles and raised cards. |
| `--inset` | `#0a0908` | Readouts, fields, and meter troughs. |
| `--raised` | `#1e1a14` | Secondary buttons. |
| `--line` | `#2b261e` | Hairline seams. |
| `--line-strong` | `#423a2f` | Field and key edges. |
| `--ink` | `#f4f0e6` | Primary text and the closed Talk key. |
| `--ink-muted` | `#aaa294` | Supporting text. |
| `--ink-soft` | `#8a8173` | Micro-labels, timestamps, disabled text. |
| `--signal` | `#ff5c2b` | Action, live state, attention, focus. |
| `--signal-hover` | `#ff754d` | Hover on the signal action. |
| `--signal-soft` | `rgba(255, 92, 43, 0.15)` | Open-mic wash and selected rows. |
| `--signal-line` | `rgba(255, 92, 43, 0.46)` | Selected-row borders. |
| `--signal-ink` | `#1a0802` | Text on a signal fill. |
| `--danger` | `#ff9a8a` | Errors only. |
| `--key-edge` | `#8f8576` | The bottom edge of the physical Talk key. |
| `--key-ink` | `#17130e` | Text and icons on the bone key. |

**Rule.** One accent hue. Signal orange is only for action, live state, attention, and focus. The other person is coded with bone and position, never a second hue.

### Type

| Token | Value | Job |
| --- | --- | --- |
| `--type-ui` | `system-ui, -apple-system, "Segoe UI", "Noto Sans", Roboto, sans-serif` | Display and UI. One family, four weights. |
| `--type-data` | `ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace` | Machine data only: room code, link, timestamps, telemetry. |
| `--text-micro` | `0.6875rem` (11 px) | Stenciled labels, uppercase, `0.14em` tracking. |
| `--text-meta` | `0.75rem` (12 px) | Supporting copy, hints. |
| `--text-body` | `0.9375rem` (15 px) | Messages and fields. |
| `--text-title` | `1rem` (16 px) | Section titles. |
| `--text-status` | `clamp(1.15rem, 1.8vw, 1.45rem)` | Channel status sentence. |
| `--weight-ui` | `550` | Default UI weight. |
| `--weight-strong` | `650` | Titles and labels. |
| `--weight-display` | `750` | Wordmark and status. |

Mono is not decoration. If the text is not a value from the machine, set it in the UI face.

### Space, radius, elevation

- Spacing snaps to 4 px: `4, 8, 12, 16, 20, 24, 32, 40`.
- Radii: `6` (field), `10` (button), `14` (card and bubble), `20` (shell), `999` (state chip only).
- Shell shadow: `inset 0 1px 0 rgba(255, 255, 255, 0.045), 0 32px 80px rgba(0, 0, 0, 0.55)`.
- Raised key: `inset 0 1px 0 #ffffff, 0 2px 0 var(--key-edge), 0 8px 18px rgba(0, 0, 0, 0.35)`.
- Motion: `140ms` for state, `80ms` for press, `ease-out`. Exits are faster than entrances. Nothing animates without carrying state.

## Components

### Shell

One frame. Header, rail, log, and dock are separated by 1 px seams, not by shadowed cards inside cards. The shell fills the viewport on phones and floats with a 20 px radius at `min-width: 700px`.

```css
.app {
  background: var(--console);
  border: 1px solid var(--line);
  border-radius: 20px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.045), 0 32px 80px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
```

### Channel readout

Uppercase micro-label, monospace code, and a lamp. The lamp is the only colored element; it reports waiting, connecting, live, or error.

```html
<p class="room">
  <span class="room-label">Channel</span>
  <span id="room-code">ABCD-EFGH</span>
  <span class="room-lamp" aria-hidden="true"></span>
</p>
```

### Responsive rules

- One frame. Below 940 px wide and 840 px tall, compact the header, rail, and dock instead of removing content.
- The pairing QR and the message log stay in the DOM and visible while waiting. The share panel hides only when a peer is connected.
- A very short window may scroll the page, but content is never hidden to make a breakpoint fit.

### Status line

The rail's hero sentence. A 9 px lamp sits in a fixed first column so state changes do not move the text. Waiting and live use ink; connecting and reconnecting use muted ink with a pulse; errors use danger.

```css
#status {
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr);
  gap: 12px;
  font-size: var(--text-status);
  font-weight: 750;
  line-height: 1.18;
  letter-spacing: -0.015em;
  text-wrap: balance;
}
```

### Talk key

The one primary action while live. Bone fill, dark ink, a 2 px bottom edge, and a mic badge. Open state swaps to signal orange, adds a 4 px soft ring, and changes the visible label to `Talking`. Disabled state drops to the rail surface with no edge.

```html
<button id="ptt" type="button">
  <span class="ptt-icon-wrap"><svg aria-hidden="true">…</svg></span>
  <span id="ptt-label">Talk</span>
  <span class="ptt-led" aria-hidden="true"></span>
</button>
```

```css
#ptt {
  min-height: 58px;
  border: 1px solid var(--ink);
  border-radius: 14px;
  background: var(--ink);
  color: var(--key-ink);
  box-shadow: inset 0 1px 0 #fff, 0 2px 0 var(--key-edge), 0 8px 18px rgba(0, 0, 0, 0.35);
}
#ptt.is-open {
  background: var(--signal);
  border-color: var(--signal);
  color: var(--signal-ink);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 0 0 4px var(--signal-soft), 0 8px 30px rgba(255, 92, 43, 0.25);
}
```

### Segmented meters

Two 8 px rails, labeled You / Them. The fill is signal for the local voice and bone for the remote voice. The segments are a mask, so the fill never stretches the gaps.

```css
.meter { position: relative; height: 8px; background: var(--inset); border: 1px solid var(--line); border-radius: 3px; }
.meter-fill { background: var(--signal); transform-origin: left center; }
.meter::after { content: ""; position: absolute; inset: 0; background: repeating-linear-gradient(90deg, transparent 0 5px, var(--inset) 5px 7px); }
.level--remote .meter-fill { background: var(--ink); }
```

### Message log

A running log, not a feed. Self sits right with a signal-tinted bubble; the other person sits left on panel graphite; system events are uppercase micro-text between two hairlines. Grouped messages hide the timestamp.

```css
.message { max-width: min(78%, 46ch); border: 1px solid var(--line); border-radius: 14px; border-bottom-left-radius: 4px; background: var(--panel); }
.message--self { align-self: flex-end; border-color: var(--signal-line); border-radius: 14px 14px 4px 14px; background: var(--signal-soft); }
.message--system { align-self: stretch; display: flex; align-items: center; gap: 10px; border: 0; background: none; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.12em; font-size: 10px; }
.message--system::before, .message--system::after { content: ""; flex: 1; height: 1px; background: var(--line); }
```

### Composer

One inset field and one quiet send action. The send button is raised graphite, not a second signal-filled primary while Talk is on screen. Focus adds a signal border and a 3 px soft ring.

```css
.composer { border-top: 1px solid var(--line); background: var(--console); }
#chat-input { height: 46px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--inset); }
#chat-input:focus-visible { outline: none; border-color: var(--signal); box-shadow: 0 0 0 3px var(--signal-soft); }
#chat-send { background: var(--raised); border: 1px solid var(--line-strong); color: var(--ink); }
```

### Pairing card

The only signal-filled action while waiting is Copy link. The link is selectable machine data; the QR sits on a white tile. In an error state Copy demotes to an outline because Try again or New room is the action.

```html
<button id="copy-link" type="button"><svg aria-hidden="true">…</svg><span>Copy link</span></button>
```

```css
#copy-link { background: var(--signal); color: var(--signal-ink); border: 0; }
body[data-state="error"] #copy-link { background: transparent; color: var(--ink); border: 1px solid var(--line-strong); }
```

### Icons

One pack: 24 px viewBox, 1.8 px stroke, round caps and joins, currentColor. The brand mark is the exception: a filled-and-stroked radio silhouette with the side key in signal orange.

### Motion

- Lamp states pulse only while connecting or reconnecting.
- An open mic fades to signal with a short ring; it does not bounce.
- Messages enter 4 px from their edge in `140ms`; system lines do not animate.
- `prefers-reduced-motion: reduce` removes pulses and typing dots and drops transitions to `0.001ms`.

## Slop checklist

- No gradient text, no decorative monospace, no emoji, no badge rows.
- No second accent. Errors use danger, not a second brand color.
- One primary action per state: Copy link while waiting, Talk while live, Try again or New room on error.
- The wordmark and mark can be removed and the console still reads as Walkie Talkie.
- The page is checked at 1440 and 390 with keyboard focus, contrast, reduced motion, and the full share → join → talk → chat journey.
