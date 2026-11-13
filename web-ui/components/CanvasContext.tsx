"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import {
  artifactVersion,
  availableViews,
  captureScrollPosition,
  hasUnseenUpdate,
  isCanvasEnabled,
  restoreScrollPosition,
  type CanvasArtifact,
  type CanvasView,
  type ScrollLike,
} from "../lib/canvas";

export interface CanvasContextValue {
  enabled: boolean;
  openArtifact: CanvasArtifact | null;
  view: CanvasView;
  setView: (view: CanvasView) => void;
  openCanvas: (artifact: CanvasArtifact, view?: CanvasView) => void;
  closeCanvas: () => void;
  /** Replace the open artifact when its source content changes mid-turn. */
  syncArtifact: (artifact: CanvasArtifact) => void;
  isOpenWith: (artifactId: string) => boolean;
  /** True when a previously seen artifact changed while the canvas was closed. */
  unseenUpdate: (artifact: CanvasArtifact) => boolean;
}

const CanvasContext = createContext<CanvasContextValue | null>(null);

export function useCanvas(): CanvasContextValue | null {
  return useContext(CanvasContext);
}

export function CanvasProvider({
  children,
  scrollElRef,
}: {
  children: React.ReactNode;
  scrollElRef?: { current: ScrollLike | null };
}) {
  const [enabled] = useState<boolean>(() => isCanvasEnabled());
  const [openArtifact, setOpenArtifact] = useState<CanvasArtifact | null>(null);
  const [view, setViewState] = useState<CanvasView>("code");
  const [seenVersions, setSeenVersions] = useState<Record<string, string>>({});
  const openArtifactRef = useRef<CanvasArtifact | null>(null);
  const savedScrollRef = useRef<number | null>(null);

  const markSeen = useCallback((artifact: CanvasArtifact) => {
    const version = artifactVersion(artifact);
    setSeenVersions((prev) =>
      prev[artifact.id] === version ? prev : { ...prev, [artifact.id]: version }
    );
  }, []);

  const openCanvas = useCallback(
    (artifact: CanvasArtifact, viewOverride?: CanvasView) => {
      if (!enabled) return;
      const el = scrollElRef?.current ?? null;
      if (el) savedScrollRef.current = captureScrollPosition(el);
      openArtifactRef.current = artifact;
      setOpenArtifact(artifact);
      const views = availableViews(artifact);
      setViewState(
        viewOverride && views.includes(viewOverride) ? viewOverride : views[0]
      );
      markSeen(artifact);
    },
    [enabled, scrollElRef, markSeen]
  );

  const closeCanvas = useCallback(() => {
    const current = openArtifactRef.current;
    if (current) markSeen(current);
    openArtifactRef.current = null;
    setOpenArtifact(null);
    const el = scrollElRef?.current ?? null;
    const saved = savedScrollRef.current;
    savedScrollRef.current = null;
    if (el && saved !== null) {
      // Restore after the sheet unmounts / layout settles, so the position
      // lands on the final chat layout rather than the canvas layout.
      if (typeof requestAnimationFrame !== "undefined") {
        requestAnimationFrame(() => restoreScrollPosition(el, saved));
      } else {
        restoreScrollPosition(el, saved);
      }
    }
  }, [scrollElRef, markSeen]);

  const syncArtifact = useCallback(
    (artifact: CanvasArtifact) => {
      if (openArtifactRef.current?.id !== artifact.id) return;
      openArtifactRef.current = artifact;
      setOpenArtifact(artifact);
      // The user is looking at it live, so the new version counts as seen.
      markSeen(artifact);
    },
    [markSeen]
  );

  const setView = useCallback((next: CanvasView) => {
    setViewState(next);
  }, []);

  const isOpenWith = useCallback(
    (artifactId: string) => openArtifact?.id === artifactId,
    [openArtifact]
  );

  const unseenUpdate = useCallback(
    (artifact: CanvasArtifact) => {
      if (!enabled) return false;
      return hasUnseenUpdate(
        seenVersions[artifact.id],
        artifactVersion(artifact),
        openArtifact?.id === artifact.id
      );
    },
    [enabled, seenVersions, openArtifact]
  );

  const value: CanvasContextValue = {
    enabled,
    openArtifact,
    view,
    setView,
    openCanvas,
    closeCanvas,
    syncArtifact,
    isOpenWith,
    unseenUpdate,
  };

  return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>;
}
