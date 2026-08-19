"use client";

import { Check, Copy, ExternalLink, MessageCircleMore } from "lucide-react";
import { useState } from "react";
import { ClaudeLogo } from "@/components/logos/claude";
import { OpenAILogo } from "@/components/logos/openai";
import { Button, buttonVariants } from "@/components/ui/button";

interface McpConnectionGuidesProps {
  readonly client?: "all" | "claude" | "chatgpt";
  readonly onGuideOpened?: (() => void) | undefined;
  readonly onProminentChatGptOpened?: (() => void) | undefined;
  readonly serverUrl: string;
}

interface GuideStep {
  readonly description: string;
  readonly title: string;
}

const claudeSteps: ReadonlyArray<GuideStep> = [
  {
    title: "Open connector settings",
    description: "In Claude, go to Settings, then Connectors.",
  },
  {
    title: "Add a custom connector",
    description: "Choose Add custom connector at the bottom of the list.",
  },
  {
    title: "Paste the name and URL",
    description: "Use the values below, then choose Add.",
  },
  {
    title: "Connect and choose access",
    description:
      "Choose Connect. Sign in here, select the WhatsApp Connections Claude can use, and approve only the permissions you want.",
  },
  {
    title: "Enable it in a chat",
    description:
      "Open Search and tools in Claude, then enable the Normal tools you want to use.",
  },
];

const chatGptSteps: ReadonlyArray<GuideStep> = [
  {
    title: "Turn on developer mode",
    description:
      "In ChatGPT, open Settings, then Security and login, and turn on Developer mode.",
  },
  {
    title: "Open ChatGPT Plugins",
    description: "Open Plugins and choose the plus button to add a server.",
  },
  {
    title: "Paste the server URL",
    description: "Use the Normal MCP server URL below and keep OAuth enabled.",
  },
  {
    title: "Choose access",
    description:
      "Sign in here, select the WhatsApp Connections ChatGPT can use, and approve read and send permissions separately.",
  },
  {
    title: "Start a new chat",
    description:
      "Enable Normal from the tools menu. ChatGPT will ask you to confirm before it sends a message.",
  },
];

function CopyValue({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="flex min-w-0 items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate font-mono text-sm" title={value}>
          {value}
        </p>
      </div>
      <Button
        aria-label={`Copy ${label}`}
        onClick={copy}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
    </div>
  );
}

function GuideCard({
  accent,
  connectUrl,
  name,
  onGuideOpened,
  onProminentChatGptOpened,
  serverUrl,
  steps,
}: {
  readonly accent: "claude" | "chatgpt";
  readonly connectUrl: string;
  readonly name: string;
  readonly onGuideOpened?: (() => void) | undefined;
  readonly onProminentChatGptOpened?: (() => void) | undefined;
  readonly serverUrl: string;
  readonly steps: ReadonlyArray<GuideStep>;
}) {
  const isChatGpt = accent === "chatgpt";

  return (
    <article className="overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10">
      <header className="flex items-center justify-between gap-4 border-b px-5 py-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className={
              accent === "claude"
                ? "grid size-9 place-items-center rounded-xl bg-[#f5ede8]"
                : "grid size-9 place-items-center rounded-xl bg-foreground"
            }
          >
            {accent === "claude" ? (
              <ClaudeLogo className="size-5" />
            ) : (
              <OpenAILogo className="size-5" />
            )}
          </span>
          <h3 className="text-lg font-semibold tracking-tight">{name}</h3>
        </div>
        <a
          aria-label={`Open ${name} guide in a new tab`}
          className={buttonVariants({ variant: "outline" })}
          href={connectUrl}
          onClick={onGuideOpened}
          rel="noopener noreferrer"
          target="_blank"
        >
          Open {name}
          <ExternalLink aria-hidden="true" data-icon="inline-end" />
        </a>
      </header>
      {isChatGpt ? (
        <div className="border-b bg-muted/20 px-5 py-5">
          <div className="flex flex-col gap-4 rounded-2xl bg-background p-4 ring-1 ring-border sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium">Open ChatGPT now</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Finish the connector setup in ChatGPT, then come back here for
                the server URL and access choices.
              </p>
            </div>
            <a
              aria-label="Open ChatGPT in a new tab"
              className={buttonVariants({ size: "lg" })}
              href={connectUrl}
              onClick={onProminentChatGptOpened}
              rel="noopener noreferrer"
              target="_blank"
            >
              Open ChatGPT
              <ExternalLink aria-hidden="true" data-icon="inline-end" />
            </a>
          </div>
        </div>
      ) : null}
      <ol className="flex flex-col px-5 py-6">
        {steps.map((step, index) => (
          <li className="grid grid-cols-[2rem_1fr] gap-3" key={step.title}>
            <div className="flex flex-col items-center">
              <span className="grid size-7 place-items-center rounded-full border bg-background text-xs text-muted-foreground">
                {index + 1}
              </span>
              {index === steps.length - 1 ? null : (
                <span
                  aria-hidden="true"
                  className="my-1 h-full w-px bg-border"
                />
              )}
            </div>
            <div className={index === steps.length - 1 ? "pb-0" : "pb-6"}>
              <p className="font-medium">{step.title}</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {step.description}
              </p>
              {index === 2 ? (
                <div className="mt-4 divide-y overflow-hidden rounded-xl border bg-muted/25">
                  <CopyValue label="Connector name" value="Normal" />
                  <CopyValue label="Server URL" value={serverUrl} />
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </article>
  );
}

const prompts = [
  "Show my most recent WhatsApp Conversations.",
  "Summarize the latest messages from my family group.",
  "Draft a WhatsApp reply to Ada. Do not send it yet.",
] as const;

export function McpConnectionGuides({
  client = "all",
  onGuideOpened,
  onProminentChatGptOpened,
  serverUrl,
}: McpConnectionGuidesProps) {
  const showClaude = client === "all" || client === "claude";
  const showChatGpt = client === "all" || client === "chatgpt";

  return (
    <section
      aria-labelledby="connect-mcp-clients"
      className="flex flex-col gap-5"
    >
      <div className="max-w-2xl">
        <p className="text-sm font-medium text-muted-foreground">MCP Clients</p>
        <h2
          id="connect-mcp-clients"
          className="mt-1 text-2xl font-semibold tracking-tight"
        >
          {client === "claude"
            ? "Connect Normal to Claude"
            : client === "chatgpt"
              ? "Connect Normal to ChatGPT"
              : "Connect Normal to Claude or ChatGPT"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Add the server once, then choose the exact WhatsApp Connections and
          permissions each MCP Client can use.
        </p>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {showClaude ? (
          <GuideCard
            accent="claude"
            connectUrl="https://claude.ai/settings/connectors"
            name="Claude"
            onGuideOpened={onGuideOpened}
            serverUrl={serverUrl}
            steps={claudeSteps}
          />
        ) : null}
        {showChatGpt ? (
          <GuideCard
            accent="chatgpt"
            connectUrl="https://chatgpt.com/plugins"
            name="ChatGPT"
            onGuideOpened={onGuideOpened}
            onProminentChatGptOpened={onProminentChatGptOpened}
            serverUrl={serverUrl}
            steps={chatGptSteps}
          />
        ) : null}
      </div>
      <div className="mt-3">
        <h3 className="text-lg font-semibold tracking-tight">Try asking</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Start with a read request or ask your MCP Client to prepare a reply.
        </p>
        <ul className="mt-3 grid gap-3 md:grid-cols-3">
          {prompts.map((prompt) => (
            <li
              className="flex gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10"
              key={prompt}
            >
              <MessageCircleMore
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <p className="text-sm leading-6">{prompt}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
