# Development and tests

Obsidian's graph view has no official API and Obsidian cannot be run in automated tests, so this folder holds a simulator of the graph view and the tests that run the plugin inside it.

## What is here

| File | What it is |
| --- | --- |
| `mock-obsidian.js` | A stand-in for Obsidian's graph view, built on the same drawing library (PixiJS 7) and following the community typings for Obsidian 1.15's graph internals: the renderer, nodes, links, the layout worker that honours pinned nodes, panning, zooming, dragging and hovering. It also provides the small part of the `obsidian` module the plugin uses. |
| `vaults.js` | Test vaults: a student vault with a Home note and six subject MOCs, plus vaults that are small, large, without MOCs, without a Home note, and without links. |
| `lib.js` | Opens the simulator in headless Chromium with the real `main.js` and `styles.css` loaded unchanged. |
| `tests.js` | Behaviour tests: the opening animation, dragging, hovering, the MOC list, turning the plugin off and on, every setting, vault edits, a graphics reset, rotation and screen sizes, the local graph, large vaults, stable colours, and the camera. |
| `fuzz.js` | Lays out hundreds of odd and random vaults and checks that no note overlaps another and that the result is repeatable. |

## Running

```
cd dev
npm install
npx playwright install chromium
npm test
npm run fuzz
```

Screenshots from the tests are written to `dev/out/`.

## What the simulator cannot tell you

It is a reconstruction, not Obsidian. It proves the plugin's own logic and drawing, and that the plugin leaves nothing behind when it is turned off. It cannot prove that a given Obsidian release still has the same internals. For that, use the **Copy report** button in the plugin's settings inside real Obsidian.
