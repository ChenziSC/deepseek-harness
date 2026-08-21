# Agent Note: Chinese explanatory comments in the browser client

Status: implemented

English | [中文](2026-08-17-client-chinese-source-comments.zh.md)

## Problem

The browser client presents Chinese product copy but historically required English source comments. That split makes the implementation harder to study for the repository's primary Chinese learning audience, while translating executable strings or generated model-facing descriptions would change behavior rather than documentation.

## Decision

Explanatory comments and JSDoc in `packages/client/*` and `apps/web` use Chinese. Code identifiers, protocol values, third-party names, and established technical terms remain unchanged. Comments preserve behavior, timing, ownership, failure, and lifecycle facts instead of translating word by word or restating code.

Runtime strings are outside this decision. Public JSDoc or source prose extracted into model-visible text, wire descriptions, or generated English catalogs retains the exact English consumed by those systems and carries a nearby Chinese explanation for readers. Test fixtures, snapshots, machine directives, and external quotations remain byte-stable when their text is part of the tested input or output.

The browser-client instruction file owns this language rule. Client changes continue to run the same type, lint, GUI, web replay, documentation, and generated-catalog checks selected for their affected behavior.

## Alternatives considered

**Keep English comments and add only external Chinese guides.** This leaves the explanation far from the implementation and lets the guide drift as local invariants change.

**Keep bilingual comments in every source file.** Duplicating every proposition increases comment density and creates two locally maintained versions without the repository's document-pairing checks.

**Translate every English string near client code.** Tool schemas, protocol values, snapshots, diagnostics, and generated model-facing prose are behavior or compatibility inputs, not source comments; changing them exceeds a learning-oriented localization.

## Consequences

Chinese readers can study non-obvious client invariants at their point of use, and future explanatory comments in this subtree follow the same language. International contributors must read Chinese prose or use the paired architecture documentation. The exception for runtime and generated English prevents comment localization from changing requests, protocols, snapshots, or public generated catalogs.
