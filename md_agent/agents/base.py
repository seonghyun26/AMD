"""Shared LangChain agent builder for AMD sub-agents."""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator

from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_anthropic import ChatAnthropic
from langchain_core.prompts import ChatPromptTemplate

MODEL = "claude-opus-4-6"


def build_executor(
    system_prompt: str,
    tools: list,
    max_iterations: int = 12,
    api_key: str | None = None,
) -> AgentExecutor:
    """Create a Claude-backed LangChain AgentExecutor."""
    llm = ChatAnthropic(
        model=MODEL,
        api_key=api_key or os.environ.get("ANTHROPIC_API_KEY", ""),
        temperature=1,
        max_tokens=8192,
        streaming=True,
    )
    prompt = ChatPromptTemplate.from_messages(
        [
            ("system", system_prompt),
            ("human", "{input}"),
            ("placeholder", "{agent_scratchpad}"),
        ]
    )
    agent = create_tool_calling_agent(llm, tools, prompt)
    return AgentExecutor(
        agent=agent,
        tools=tools,
        verbose=False,
        max_iterations=max_iterations,
        return_intermediate_steps=True,
    )


async def stream_executor(
    executor: AgentExecutor,
    input_text: str,
) -> AsyncGenerator[dict, None]:
    """Convert LangChain astream_events to our SSE event dicts.

    Yields dicts matching the SSE schema used by the main MDAgent:
      text_delta, tool_start, tool_result, agent_done, error
    """
    tool_id_map: dict[str, str] = {}  # run_id → tool_use_id

    try:
        async for event in executor.astream_events({"input": input_text}, version="v2"):
            kind: str = event["event"]

            if kind == "on_chat_model_stream":
                chunk = event["data"]["chunk"]
                content = getattr(chunk, "content", "")
                if isinstance(content, str) and content:
                    yield {"type": "text_delta", "text": content}
                elif isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text = block.get("text", "")
                            if text:
                                yield {"type": "text_delta", "text": text}

            elif kind == "on_tool_start":
                run_id: str = event.get("run_id", "")
                tool_use_id = f"lc_{run_id[:12]}"
                tool_id_map[run_id] = tool_use_id
                raw_input = event["data"].get("input", {})
                yield {
                    "type": "tool_start",
                    "tool_use_id": tool_use_id,
                    "tool_name": event["name"],
                    "tool_input": raw_input
                    if isinstance(raw_input, dict)
                    else {"input": str(raw_input)},
                }

            elif kind == "on_tool_end":
                run_id = event.get("run_id", "")
                tool_use_id = tool_id_map.get(run_id, f"lc_{run_id[:12]}")
                raw_out = event["data"].get("output", "")
                display = str(raw_out)
                if len(display) > 2000:
                    display = display[:2000] + "\n…[truncated]"
                yield {
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "tool_name": event["name"],
                    "result": {"output": display},
                }

            elif kind == "on_chain_end" and event["name"] == "AgentExecutor":
                out = event["data"].get("output", {})
                final = out.get("output", "") if isinstance(out, dict) else str(out)
                yield {"type": "agent_done", "final_text": final}
                return

    except Exception as exc:
        yield {"type": "error", "message": str(exc)}


def sync_run(executor: AgentExecutor, input_text: str) -> str:
    """Run the executor synchronously and return the final text output."""
    result = executor.invoke({"input": input_text})
    return result.get("output", "")
