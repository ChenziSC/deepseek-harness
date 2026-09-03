# DeepSeek Harness course answer key

English | [中文](README.zh.md)

Each lesson has a separate answer file. Every conclusion is based on the current DeepSeek Harness repository. The answers focus on design principles, responsibility boundaries, runtime sequences, and state ownership rather than line-by-line implementation details.

Read the corresponding lesson before answering its questions. In each lesson, `C1` compares Pi, Claude Code, and DSH, while `Q1...` covers DSH architecture. The matching answer file contains the reference answers. Use the [course roadmap](../course-roadmap.md) to choose an order. L0–L5 form the required core; L6–L8 and L9–L11 are separate branches and do not need to be alternated.

## Required core answers

1. [Lesson 0 answer: From command entry point to plugin tree](00-entry-and-composition-answers.md)
2. [Lesson 1 answer: Cordis lifecycle and “everything is a plugin”](01-cordis-lifecycle-answers.md)
3. [Lesson 2 answer: Session, AgentRegistry, and AgentLoop](02-session-agent-loop-answers.md)
4. [Lesson 3 answer: How one Turn passes through multiple Steps](03-turn-step-runtime-answers.md)
5. [Lesson 4 answer: Why model-visible state must be reconstructable](04-reconstructable-model-context-answers.md)
6. [Lesson 5 answer: Persistence, Projection, and recovery](05-persistence-projection-recovery-answers.md)

## Product-surface branch answers

7. [Lesson 6 answer: How the Web Host projects the same Agent runtime](06-web-host-runtime-answers.md)
8. [Lesson 7 answer: Dynamic Client Modules and Slot-based page composition](07-client-modules-and-slots-answers.md)
9. [Lesson 8 answer: Input, attachments, and model-request projection](08-input-attachment-request-projection-answers.md)

## Capability-extension branch answers

10. [Lesson 9 answer: Subagents, background Jobs, and Agent Teams](09-subagents-jobs-teams-answers.md)
11. [Lesson 10 answer: Credential References and interactive authorization](10-credentials-authorization-answers.md)
12. [Lesson 11 answer: Complete capability seams and code execution](11-capability-seams-code-execution-answers.md)

## How to use the answers

1. Read the lesson and answer its questions independently.
2. Open the corresponding answer file and compare each answer's responsibilities, sequence, and state ownership.
3. When conclusions differ, follow the source anchors in the answer instead of tracing incidental implementation detail.
4. Answer again in your own words; explaining why the layers exist matters more than reproducing the reference answer.
