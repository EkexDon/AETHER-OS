---
title: Task fixture
tags: [fixture]
- [ ] not a task (frontmatter)
---
# Task Fixture

Shared by the Rust and TypeScript task parsers. Both assert their output
against tasks.expected.json — regenerate it when this file changes.

## Basics
- [ ] Plain todo
- [x] Done lowercase
- [X] Done uppercase
* [ ] Star bullet
+ [ ] Plus bullet
1. [ ] Numbered dot
2) [/] Numbered paren in progress
- [-] Cancelled item
- [>] Forwarded keeps its char
- [?] Question mark status
- [ ] Trailing blanks   
- [ ] Block reference ^abc123
- [ ] #tagfirst at the start
- [ ] 📅 2026-12-24
- [ ]
- [x]no space is not a task
- [link](https://example.com) is not a task
- [[Wikilink]] is not a task

## Nesting
- [ ] Parent task
  - [ ] Child task
    - [x] Grandchild done
  - Plain child bullet
    - [ ] Under plain bullet
	- [ ] Tab indented child
- [ ] Back to top
> - [ ] Quoted task
>   - [/] Quoted nested

Paragraph resets nesting.
  - [ ] Indented after paragraph

## Dates & priorities ##
- [ ] Emoji due 📅 2026-09-30
- [ ] Calendar variants 📆 2026-10-01 and 🗓️ 2026-10-02
- [ ] Full Tasks line 🔺 🛫 2026-09-01 ⏳ 2026-09-20 📅 2026-09-25 ➕ 2026-08-15 #work
- [x] Completed with date ⏫ 📅 2026-09-10 ✅ 2026-09-09 ^done-1
- [-] Cancelled with date ❌ 2026-09-11
- [ ] Text due due:2026-11-01 !high
- [ ] due:2026-12-01 at the start
- [ ] Spaced due: 2026-11-02 and more
- [ ] Parenthesised (due: 2026-11-03) !medium
- [ ] Dataview [due:: 2026-11-04] [scheduled:: 2026-11-01]
- [ ] At syntax @due(2026-11-05) !low
- [ ] Priority words !urgent and a later !low
- [ ] Emoji priorities 🔼 then 🔽
- [ ] Lowest ⏬ and not!high
- [ ] Invalid 📅 2026-02-30 stays in text
- [ ] Glued overdue:2026-09-30 and due:2026-09-30T10 are ignored
- [x] Dataview completion [completion:: 2026-09-12]

## Tags and links
- [ ] Tagged #home #errand/shop #home and (#paren) #42 x#no
- [ ] Code `#notatag` and `📅 2026-01-01` inside ticks #real
- [ ] Link to [[Other Note]] and [[Alias Target|alias]] #links
- [ ] Unicode #café and #日本語 tags

### C# notes
- [ ] Heading with a hash in its title

## Code
```markdown
- [ ] inside a backtick fence
```
~~~
```
- [ ] inside a tilde fence with inner backticks
~~~
````md
- [ ] inside a four-backtick fence
```
- [ ] still inside
````
```inline``` is not a fence
- [ ] After the code

## Tasks
- [ ] Last task in the tasks section
