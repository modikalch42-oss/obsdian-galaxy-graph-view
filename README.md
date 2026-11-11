# Galaxy Graph for Obsidian

Turns Obsidian's graph view into a multicoloured galaxy.

- **Coloured star-nodes**: the most-linked notes glow white-gold like galactic cores, while loosely linked notes fade out to cyan, blue and violet. You can also colour by folder or go full rainbow.
- **Deep-space background**: a twinkling starfield, nebula clouds and the occasional shooting star.
- **Parallax**: stars drift slightly as you pan the graph.
- **Glow**: soft bloom around nodes, with faint blue link threads.
- **HUD-style graph controls**.

Works on desktop and mobile (plain JavaScript, no build step).

## Install

### Manually
1. Download `manifest.json`, `main.js` and `styles.css`.
2. Put them in `<your vault>/.obsidian/plugins/galaxy-graph/`.
3. In Obsidian, open Settings → Community plugins, reload, and enable **Galaxy Graph**.

### With BRAT
Install the BRAT plugin, then add this repository: `modikalch42-oss/obsdian-galaxy-graph-view`.

## Settings
- **Node colours**: by connections, by folder, or rainbow
- **Starfield, nebula clouds, shooting stars, parallax**: each can be switched on or off
- **Twinkle and glow**: turn these off on large graphs or to save battery
- **Star density**

There is also a command, **Toggle galaxy graph**.

## Note
Obsidian has no official API for per-node graph colours, so node colouring patches the graph renderer's internals and may need updating after Obsidian releases. The background, glow and link colours use plain CSS.
