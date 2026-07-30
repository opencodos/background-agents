// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SandboxEvent } from "@/types/session";
import { EventItem } from "./session-timeline";

expect.extend(matchers);
afterEach(cleanup);

function event(userId?: string): Extract<SandboxEvent, { type: "user_message" }> {
  return {
    type: "user_message",
    content: "hello",
    messageId: "message-1",
    timestamp: 1,
    author: {
      participantId: "participant-2",
      ...(userId ? { userId } : {}),
      name: "Historical Name",
      avatar: "https://historical.example/avatar",
    },
  };
}

describe("user message authors", () => {
  it("presents Autofix provenance and links to the originating review", () => {
    render(
      <EventItem
        event={{
          ...event("user-2"),
          autofix: {
            feedbackKind: "review",
            authorType: "bot",
            pullRequestNumber: 42,
            feedbackUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-5678",
          },
        }}
        sessionId="session-1"
        currentParticipantId="participant-1"
        participantProfiles={{}}
        onOpenMedia={() => {}}
      />
    );

    expect(screen.getByText("Resumed by PR feedback")).toBeInTheDocument();
    expect(screen.getByText("Review · Bot · PR #42")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open feedback" })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/pull/42#pullrequestreview-5678"
    );
  });

  it("uses the canonical profile name and avatar when available", () => {
    render(
      <EventItem
        event={event("user-2")}
        sessionId="session-1"
        currentParticipantId="participant-1"
        participantProfiles={{
          "user-2": {
            userId: "user-2",
            displayName: "Canonical Name",
            avatarUrl: "https://canonical.example/avatar",
          },
        }}
        onOpenMedia={() => {}}
      />
    );

    expect(screen.getByText("Canonical Name")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Canonical Name" })).toHaveAttribute(
      "src",
      "https://canonical.example/avatar"
    );
  });

  it("falls back safely for historical events without userId", () => {
    render(
      <EventItem
        event={event()}
        sessionId="session-1"
        currentParticipantId="participant-1"
        participantProfiles={{}}
        onOpenMedia={() => {}}
      />
    );

    expect(screen.getByText("Historical Name")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Historical Name" })).toHaveAttribute(
      "src",
      "https://historical.example/avatar"
    );
  });

  it("preserves event fallbacks when canonical profile fields are null", () => {
    render(
      <EventItem
        event={event("user-2")}
        sessionId="session-1"
        currentParticipantId="participant-1"
        participantProfiles={{
          "user-2": { userId: "user-2", displayName: null, avatarUrl: null },
        }}
        onOpenMedia={() => {}}
      />
    );

    expect(screen.getByText("Historical Name")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Historical Name" })).toHaveAttribute(
      "src",
      "https://historical.example/avatar"
    );
  });
});
