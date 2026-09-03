# Phase 14 Studio Product Experience

The Studio uses an Editorial Atelier system: warm neutral reading surfaces, restrained burgundy for actions, and fine borders instead of dashboard decoration. The information path is 学习 → 理解 → 表达; shared navigation derives its active state from the pathname, including nested routes.

Desktop navigation is grouped as 学习、理解、表达、系统. At small widths it becomes five touch-sized destinations: 首页、知识库、认知、表达、更多. `studio-display.ts` is the single deterministic mapping for mastery language, rubric labels, and status tones. No display helper invokes a Provider.
