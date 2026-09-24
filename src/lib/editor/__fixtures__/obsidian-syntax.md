---
title: Obsidian syntax fixture
tags: [fixture, editor]
related: "[[AETHER-OS]]"
---
# Obsidian syntax fixture

Round-trip fixture for the note editor: every construct below must be
saved back byte for byte when it is not edited.

## Links
- Plain: [[AETHER-OS]] and [[AETHER-OS Roadmap]].
- Alias: [[Local-first Sync|sync notes]], heading: [[Rust Ownership#Rules]].
- Heading with alias: [[Tauri 2 Cheatsheet#Commands|Tauri commands]]
- Same note: [[#Links]] and a block: [[Health#^sleep-target]]
- Folder path: [[01-Projects/Masterarbeit]] · missing: [[Not written yet]]
- Adjacent: [[A]][[B]], in parentheses ([[React Patterns]]), bold **[[Health]]**.
- Not links: `[[inside code]]`, \[[escaped]], [single brackets] and [[]].

## Embeds
![[aether-architecture.png|480]]
![[garden-sketch.png|300x200]]

Inline embed ![[sourdough.jpg]] in a sentence, a note embed ![[Weekly Review Checklist]] and a clip ![[demo.mp4]].

## Tags, highlights, comments
Tags: #meta #para/sub-tag #under_score #2026 is not a tag, and neither is a#b.
Some ==highlighted text== and ==more==.
An inline %%hidden comment%% stays, as does <!-- an HTML comment -->.

%%
A block comment
spanning [[lines]] and *markup*.

Even a blank line.
%%

<!--
An HTML comment block.
-->

## Math
Inline $e^{i\pi} + 1 = 0$ and $a_1 * b_2$ and $\{x \mid x > 0\}$, but $5 and $10 is money.
Display on one line: $$\sum_{k=1}^{n} k$$

$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$

## Footnotes
A claim with a footnote[^1] and another one[^note].

[^1]: The first footnote.
[^note]: A named footnote with a [[AETHER-OS|link]].

## Callouts
> [!note] A note callout
> With a body line and a [[AETHER-OS]] link.

> [!warning]- Folded warning
> - a list inside
> - [ ] a task inside

> Plain quote, not a callout.

## Lists
* Star bullets
* stay stars
  * nested star
+ Plus bullets
+ stay plus

1) Parenthesis numbers
2) stay parenthesis

- Mixed list with plain items
- [ ] and task items
- [x] in one list
- back to plain

- [/] In progress status
- [-] Cancelled status

## Breaks and escapes
Line one
line two, a soft break.
Hard break with backslash\
next line.
Escapes: \*not emphasis\*, 5 \* 3, snake_case_name, C:\Users\demo, a -> b, 1 < 2, AT&T, \# not a heading.
Arrows → and emoji 📅 2026-09-24 stay.

| Note | Link |
| --- | --- |
| Table link | [[AETHER-OS\|alias in a table]] |
| Pipes | a \| b |

```ts
const link = "[[not a link]]"; // code keeps ``` fences
```

![Sourdough](attachments/sourdough.jpg)
## Heading right after an image

Final paragraph with trailing text.
