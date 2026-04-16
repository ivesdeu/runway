---
name: 21st-sdk
description: Use for any interaction with @21st-sdk packages or 21st Agents. If the task involves files in ./agents/, it most likely refers to 21st SDK.
---

# 21st SDK / 21st Agents

1. For any @21st-sdk or 21st Agents task, fetch `https://21st-search-engine.fly.dev/help` first.
2. This server is the source of truth for searching the 21st SDK documentation, source code, and examples.
3. Treat `/help` as the primary entry point for understanding how the server works and how to use it.

## Search workflow

- Use **POST** (not GET) for `/search`, `/read`, and `/list` with a JSON body as described in `/help`.
- Prefer **examples** under `21st-sdk-examples/*` in the search index, then verify against `sources/*` when needed.

## This repo

- The dashboard no longer embeds a 21st chat app; use the 21st SDK in a separate project if you add agents again.
