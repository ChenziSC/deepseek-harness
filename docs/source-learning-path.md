# Source Learning Path

English | [中文](source-learning-path.zh.md)

This path is for maintainers who want to understand DeepSeek Harness design rather than read the implementation line by line. The unit of study is an observable runtime flow, not a file: identify who owns an input, then follow events, services, and lifecycle to its output. Each lesson closely reads only a few entry points and uses tests and READMEs to verify the remaining responsibilities.

## How to use this path

Use the same order for every lesson: read the “Concept goal,” locate the code along the “Runtime blocks,” execute the “Observation,” and answer the “Checkpoint.” Do not expand types, styles, or fixtures at the start. Descend one layer only when a runtime block cannot yet be explained.

Complete lessons 0–4 first to establish the main spine. Lessons 5–8 explain how the current Web product projects that spine to users. Study the replaceable capabilities in lessons 9–11 last. The full path takes about two to three weeks, with half a day to one day per lesson.

## Overall mental model

A request does not make the CLI call one large function. The application first layers composition-bundle patches into a Cordis plugin tree. That tree provides Session, agent, LLM, tool, and other services. The agent loop advances only turns and steps. All model-visible inputs and user-visible results enter Session events. The Host projects events into client state, and the browser uses dynamic modules and slots to select the concrete UI.

| Layer | Main question | Source of truth |
|---|---|---|
| Composition | Which capabilities did this process load? | profile, bundle patches, `cordis.yml` |
| Execution | Why did the current turn continue, stop, or retry? | agent inbox, agent loop, event dispatch |
| Record | Which facts can be restored, replayed, and paged? | append-only Session event log |
| Projection | How do the Host and browser obtain current state? | Session projections, API remotes, client assembler |
| Presentation | Which plugin owns a piece of UI? | client manifest, slot registration, and locale |

## Lesson 0: From command entry to plugin tree

**Concept goal:** Understand that “starting the application” means parsing a mode, composing a profile, and mounting a Cordis configuration tree, not instantiating a fixed application class.

**Runtime blocks:**

1. **Command dispatch:** The top-level `switch` in [`apps/cli/src/bin.ts`](../apps/cli/src/bin.ts) selects only the `profile`, `plugin`, or `dump-config` path. Dynamic imports keep other modes out of the current launch path.
2. **Profile composition:** [`apps/cli/src/profile-boot.ts`](../apps/cli/src/profile-boot.ts) reads the profile manifest and composes bundles, user patches, and command-line overlays in priority order.
3. **Root context:** `boot()` in [`packages/boot/app-boot/src/index.ts`](../packages/boot/app-boot/src/index.ts) creates the Cordis root context, mounts the include, and waits until the entire configuration tree activates.
4. **Concrete assembly:** [`apps/cli/config/agent-presets/standard/agent.cordis.yml`](../apps/cli/config/agent-presets/standard/agent.cordis.yml) and [`packages/bundle/web-app/cordis.patch.yml`](../packages/bundle/web-app/cordis.patch.yml) show the final form in which plugin rows compose a feature.

**Observation:** Run `pnpm dsh --profile web --dump-config`, choose one UI plugin in the output, and identify which patch layer inserted it into the tree.

**Checkpoint:** Explain why a new feature normally adds a plugin or bundle configuration instead of changing the CLI entry.

## Lesson 1: Cordis lifecycle and “everything is a plugin”

**Concept goal:** Understand how context, service injection, effect disposers, and plugin fibers jointly determine resource ownership.

**Runtime blocks:**

1. **Declare dependencies:** Use [`docs/cordis-primer.md`](cordis-primer.md) to understand `inject`, `ctx.plugin()`, and `ctx.get()`. Dependencies determine when a plugin may activate.
2. **Register contributions:** Observe in [`packages/core/system-prompt/src/index.ts`](../packages/core/system-prompt/src/index.ts) how a registry service accepts plugin contributions and returns a disposer.
3. **Bind lifecycle:** Observe in [`packages/boot/app-boot/src/index.ts`](../packages/boot/app-boot/src/index.ts) how a failed launch disposes the partially constructed root context.
4. **Verify relationships:** Read the invariant rules in [`packages/AGENTS.md`](../packages/AGENTS.md) and distinguish “a service exists” from “the plugin-owned relationship still holds.”

**Observation:** Choose one `ctx.effect()` registration and draw the four moments “create → externally visible → disposer → no longer visible.”

**Checkpoint:** Explain why directly mutating a global array or leaving a listener without a disposer breaks plugin unload semantics.

## Lesson 2: The Session, agent, and agent-loop spine

**Concept goal:** Separate three roles that are often conflated: Session preserves facts, AgentRegistry manages live agents, and AgentLoop provides the concrete driver.

**Runtime blocks:**

1. **Session identity and log:** [`packages/core/session/src/index.ts`](../packages/core/session/src/index.ts) defines the Session store and event-append interface.
2. **Agent registration:** `AgentRegistry` in [`packages/core/agent/src/index.ts`](../packages/core/agent/src/index.ts) manages the creation factory, live instances, and initiator ownership.
3. **Concrete implementation:** `ReactLoopAgent` in [`packages/core/agent-loop/src/agent.ts`](../packages/core/agent-loop/src/agent.ts) owns the inbox, phase, and driver state.
4. **Publication transaction:** [`packages/core/agent-loop/README.md`](../packages/core/agent-loop/README.md) explains how create/resume publishes Session and Agent in order after setup completes.

**Observation:** Follow `AgentRegistry.create()` to the concrete factory, then record the order of Session creation, agent creation, and loop start.

**Checkpoint:** Explain why a caller cannot observe a half-configured agent before creation finishes and why the handle represents disposal capability.

## Lesson 3: How one turn advances

**Concept goal:** Learn the Session > Turn > Step hierarchy and how the inbox, system prompt, LLM stream, and tool calls let one turn contain multiple steps.

**Runtime blocks:**

1. **Claim input:** `ReactLoopAgent.preStep()` claims target messages from the inbox and assembles the system-prompt context for this step.
2. **Establish boundaries:** `ReactLoopAgent.turn()` appends `turn/start` and `step/start`, then records claimed messages as `user/message` events.
3. **Request the model:** `ReactLoopAgent.step()` resolves the model target, collects tool schemas, and uses `prepareCall()` to bind capability checks and the actual stream to one provider-configuration snapshot before recording streaming output.
4. **Execute tools:** [`packages/core/agent-loop/src/tool-calls.ts`](../packages/core/agent-loop/src/tool-calls.ts) pairs tool calls with results. New inbox messages may enter the next step.
5. **Determine the ending:** The loop appends `step/end` and `turn/end`, preserving a structured completed, max-tokens, blocked, aborted, or error reason.

**Observation:** Run one question that needs only an answer and one that needs a tool. Compare their Turn/Step counts and event order.

**Checkpoint:** Explain why one user message is one wake-up but does not necessarily produce only one model request.

## Lesson 4: Why model-visible content must be logged

**Concept goal:** Understand where system prompts, tool schemas, context injection, and model messages are assembled, plus the “model-visible ⟺ reconstructable from the log” rule.

**Runtime blocks:**

1. **Prompt registration:** [`packages/core/system-prompt/src/index.ts`](../packages/core/system-prompt/src/index.ts) aggregates named sections and variables contributed by plugins.
2. **Tool registration:** [`packages/core/tools/src/index.ts`](../packages/core/tools/src/index.ts) manages tools, presentation intent, and the Code Mode surface.
3. **Request header:** [`packages/core/session/src/request-header.ts`](../packages/core/session/src/request-header.ts) records the model, options, and context provenance selected for one request.
4. **Runtime English:** Default system prompts, tool schemas, and model format constraints stay in English because they are sent to the model or parsed by machines. Chinese learning explanations belong only in adjacent comments and documentation.

**Observation:** Choose one prompt section and answer who registers it, when it is assembled, which event records it, and which KV Cache prefix a change affects.

**Checkpoint:** Classify an English string as explanatory copy, model runtime text, or a protocol field, then choose translation, annotation, or preservation.

## Lesson 5: Persistence, projections, and recovery

**Concept goal:** Understand that the log is the source of truth, projections are recomputable read models, and SQLite/JSONL are persistence providers.

**Runtime blocks:**

1. **Append facts:** [`packages/core/session/src/types.ts`](../packages/core/session/src/types.ts) defines the event envelope and type-extension mechanism.
2. **Persist:** [`packages/session/session-persistence/README.md`](../packages/session/session-persistence/README.md) explains prepare, append, and recovery responsibilities.
3. **Host projection:** The registry in [`packages/session/session-projection/src/index.ts`](../packages/session/session-projection/src/index.ts) folds multiple projection units into queryable state.
4. **Client mirror:** [`packages/client/runtime/src/client/sessions/projection-store.ts`](../packages/client/runtime/src/client/sessions/projection-store.ts) stores Host projection values. [`conversation-assembler.ts`](../packages/client/runtime/src/client/sessions/conversation-assembler.ts) then assembles an event window into business nodes for each view.

**Observation:** Trace one UI statistic back to its projection unit and then to the Session events it consumes. Confirm that paging does not change its value.

**Checkpoint:** Explain why product state that must recover cannot live only in a React store or process-local Map.

## Lesson 6: How the Web Host starts and connects the browser

**Concept goal:** Understand that the Web bundle owns a start command, Host services, static assets, and browser connection together, while multiple plugins still collaborate to supply them.

**Runtime blocks:**

1. **Command entry:** [`packages/bundle/web-app/src/startup.ts`](../packages/bundle/web-app/src/startup.ts) registers the Web command and decides when to start the surface.
2. **Host assembly:** [`packages/bundle/web-app/src/index.ts`](../packages/bundle/web-app/src/index.ts) connects the webserver, API proxy, static frontend, and browser auto-open policy.
3. **Remote interfaces:** [`packages/api/remotes/README.md`](../packages/api/remotes/README.md) explains how plugins project RPCs and event streams consumed by the browser.
4. **Index injection:** [`packages/host/frontend-static/README.md`](../packages/host/frontend-static/README.md) explains how the Host injects the client module manifest and startup data into the index page.

**Observation:** Start `pnpm dsh web` and distinguish index, client bundle, RPC, and event-stream requests in the browser network panel.

**Checkpoint:** Explain why the Web UI neither imports the entire backend directly nor lets one “Web application plugin” own every feature.

## Lesson 7: Dynamic client modules and slots

**Concept goal:** Understand that the Host sends a module manifest first, the browser loads bundles in dependency order, and features enter existing pages through slot registration rather than one central App component.

**Runtime blocks:**

1. **Module protocol:** [`packages/client/modules/src/client/manifest.ts`](../packages/client/modules/src/client/manifest.ts) defines the records and dependencies the Host uses to describe modules.
2. **Module loading:** [`packages/client/modules/src/client/system.ts`](../packages/client/modules/src/client/system.ts) provides module factories, `require`, and dynamic bundle loading.
3. **Client root:** [`packages/client/runtime/src/client/index.ts`](../packages/client/runtime/src/client/index.ts) registers Session, workspace, and common client services.
4. **Page composition:** [`packages/client/ui-conversation/src/client/apply.ts`](../packages/client/ui-conversation/src/client/apply.ts) declares the conversation-page skeleton and slots. Tool, attachment, model-selection, and other packages fill named positions independently.

**Observation:** Choose either the `conversation.view` or `tool.call.toolview` slot and list its owner, registrants, injected props, and unload result.

**Checkpoint:** Explain why synchronous `require` cannot wait for a module that has not arrived and why the Host must send providers first according to the external dependency graph.

## Lesson 8: Input, attachments, request projection, settings, and multiple views

**Concept goal:** Understand that browser input does not send a string directly and images are not copied unchanged into every model request. Input crosses draft state, Host admission, provider-independent durable normalization, route-specific request projection, provider wire representation, and view projection.

**Runtime blocks:**

1. **Input state machine:** [`packages/client/ui-conversation/src/client/input/machine.ts`](../packages/client/ui-conversation/src/client/input/machine.ts) manages draft phases. `facade.ts` maps UI actions to submission transactions.
2. **Admission and durable normalization:** [`packages/host/apiproxy/src/api-proxy.ts`](../packages/host/apiproxy/src/api-proxy.ts) atomically admits the whole image batch before appending the message event. [`packages/attachment/attachment-local/src/normalization.ts`](../packages/attachment/attachment-local/src/normalization.ts) converges format, orientation, colour space, and size into a provider-independent normalized object. The Session log stores only its content-addressed reference.
3. **Route request projection:** [`packages/attachment/attachment-local/src/request-image.ts`](../packages/attachment/attachment-local/src/request-image.ts) generates a deterministic request version under the model route's pixel and encoded-byte budgets. Its variant id covers the source attachment identity and every transformation policy, allowing cache reuse without leaking provider limits into durable storage.
4. **Request capacity and provider representation:** [`packages/llm/llm/src/content.ts`](../packages/llm/llm/src/content.ts) replaces the oldest excess images with deterministic English placeholders. [`packages/llm/llm-deepseek/src/adapter.ts`](../packages/llm/llm-deepseek/src/adapter.ts) first represents every retained image through a Files API file id; if any resolution fails, it re-trims and reserializes the whole request under the base64 bound so one request never mixes representations. A pi-ai route builds its base64 Context from the same request versions.
5. **Plugin settings:** [`packages/client/ui-settings/README.md`](../packages/client/ui-settings/README.md) explains how plugin-owned schemas enter the unified settings UI through a Host mirror.
6. **Parallel views:** Chat and [`packages/client/ui-trajectory/README.md`](../packages/client/ui-trajectory/README.md) consume the same event window but own separate Definitions, assembler state, and renderers.

**Observation:** Send an image that needs scaling and record its draft id, Host admission, normalized attachment id, request variant id, and final wire representation. Then make Files API resolution fail and verify that every retained image changes to base64 while the Session events and durable references remain unchanged.

**Checkpoint:** Explain why durable storage owns a provider-independent normalized image, the route creates a separate request version, the Adapter chooses file id or base64, and none of those three responsibilities belongs in temporary `ui-conversation` state.

## Lesson 9: Subagents, background jobs, and experimental Agent Teams

**Concept goal:** Distinguish the capability definition, concrete providers, model tools, and client presentation. Understand that ownership of a child run and parent-child communication are separate concepts.

**Runtime blocks:**

1. **Capability registry:** `SubagentRuntime` in [`packages/subagent/subagent/src/index.ts`](../packages/subagent/subagent/src/index.ts) manages named providers.
2. **Run lifecycle:** [`packages/subagent/subagent/src/lifecycle.ts`](../packages/subagent/subagent/src/lifecycle.ts) unifies foreground, background, continuation, and settlement facts.
3. **Model consumer:** [`packages/subagent/tool-subagent/src/index.ts`](../packages/subagent/tool-subagent/src/index.ts) wraps delegation as a model tool. Separate packages own control and reporting.
4. **Experimental layer:** Agent Teams in [`packages/experimental/README.md`](../packages/experimental/README.md) prototypes a roster, mailbox, and shared task DAG on the real runtime but is excluded from official releases.

**Observation:** Compare the in-process provider with one out-of-process provider. Identify the shared `SubagentRequest`/result obligations and the resources each provider owns.

**Checkpoint:** Explain why “add a kind of subagent” registers a provider instead of adding a provider branch to the tool implementation.

## Lesson 10: Credential records and interactive authorization

**Concept goal:** Separate credential references in configuration, credential records stored by providers, and authorization flows that must ask the user before obtaining a credential.

**Runtime blocks:**

1. **References and records:** [`packages/credentials/credentials/src/index.ts`](../packages/credentials/credentials/src/index.ts) provides resolution and record registries.
2. **Local provider:** [`packages/credentials/credentials-local/README.md`](../packages/credentials/credentials-local/README.md) determines environment-variable and local credential-file priority.
3. **Authorization flow:** [`packages/credentials/authorization/src/index.ts`](../packages/credentials/authorization/src/index.ts) asks through the interaction service, writes a record, and returns its key.
4. **Consumption boundary:** A model provider resolves the reference at its operation boundary. The UI reads only safe metadata, never the secret value.

**Observation:** Follow one model provider’s `CredentialRef` to its resolution call. Mark which step may show an interaction, which touches plaintext, and which returns metadata only.

**Checkpoint:** Explain why an API key cannot enter a settings projection, Session log, or generic error text directly.

## Lesson 11: Capability seams and code execution

**Concept goal:** Use code runtime as the example for a complete capability seam made of Service Definition, Service Provider, and Consumer roles.

**Runtime blocks:**

1. **Service Definition:** [`packages/code-runtime/code-runtime/src/index.ts`](../packages/code-runtime/code-runtime/src/index.ts) defines languages, bindings, requests, and results without selecting an isolation implementation.
2. **Service Provider:** [`packages/code-runtime/code-runtime-worker-thread/src/index.ts`](../packages/code-runtime/code-runtime-worker-thread/src/index.ts) supplies Worker-thread execution. The Python provider has a separate fd3 JSONL protocol.
3. **Protocol boundary:** [`packages/code-runtime/code-runtime-python/src/protocol.ts`](../packages/code-runtime/code-runtime-python/src/protocol.ts) validates cross-process messages, budgets, and error classification. Fields and machine output stay stable English.
4. **Consumer:** [`packages/core/tools/src/code-mode.ts`](../packages/core/tools/src/code-mode.ts) turns a registered runtime into a model-callable Code Mode tool.

**Observation:** Replace or disable one Service Provider, confirm that the Consumer request type does not change, and record the earliest resolvable point where the missing provider fails.

**Checkpoint:** For any new capability, draw the three roles, configuration resolution point, cross-boundary validation point, and lifecycle owner.

## Maintenance order after the course

For a new requirement or failure, locate the result a user or model actually sees, then find the plugin that owns it. Trace upward to the projection, event, or service it consumes. Confirm who records the fact and who releases the resource. Enter the concrete algorithm last. If a change enters a model request, inspect Session events and snapshots. If it enters the Web UI, inspect locale, slots, Host projections, and GUI tests. If it crosses a process, inspect protocol validation, error classification, and shutdown paths.

This order avoids fixing presentation problems in the agent loop, placing durable state in a client store, or leaking one provider’s special behavior into the capability interface.
