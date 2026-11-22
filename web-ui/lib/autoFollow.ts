/**
 * Pure auto-follow & floating "↓ Live" pill state derivation for the chat scroll container.
 */

export const AUTO_FOLLOW_THRESHOLD_PX = 90;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  thresholdPx?: number;
}

export interface FollowState {
  distanceFromBottom: number;
  isAtBottom: boolean;
  shouldShowLivePill: boolean;
}

export function computeFollowState(metrics: ScrollMetrics): FollowState {
  const threshold = metrics.thresholdPx ?? AUTO_FOLLOW_THRESHOLD_PX;
  const distanceFromBottom = Math.max(
    0,
    metrics.scrollHeight - (metrics.scrollTop + metrics.clientHeight)
  );
  const isAtBottom = distanceFromBottom <= threshold;
  return {
    distanceFromBottom,
    isAtBottom,
    shouldShowLivePill: !isAtBottom,
  };
}

export function shouldAutoScrollOnUpdate(input: {
  isFollowPinned: boolean;
  isStreaming: boolean;
  isUserScrolledUp: boolean;
}): boolean {
  return input.isFollowPinned && input.isStreaming && !input.isUserScrolledUp;
}
