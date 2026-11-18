import { useCallback, useRef, useState } from "react";

export type PlaybackHook = {
  currentFrame: number;
  setCurrentFrame: React.Dispatch<React.SetStateAction<number>>;
  playing: boolean;
  setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  currentFrameRef: React.MutableRefObject<number>;
  playingRef: React.MutableRefObject<boolean>;
  seekTo: (frame: number) => void;
  togglePlay: () => void;
  stepFrames: (delta: number) => void;
};

export function usePlayback(
  durationFrames: number,
  onEmptyTimeline?: () => void,
): PlaybackHook {
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(false);

  const currentFrameRef = useRef(0);
  const playingRef = useRef(false);

  currentFrameRef.current = currentFrame;
  playingRef.current = playing;

  const seekTo = useCallback(
    (frame: number) => {
      setPlaying(false);
      setCurrentFrame(Math.max(0, Math.min(durationFrames, Math.round(frame))));
    },
    [durationFrames],
  );

  const togglePlay = useCallback(() => {
    if (durationFrames <= 0) {
      onEmptyTimeline?.();
      return;
    }
    if (playingRef.current) {
      setPlaying(false);
      return;
    }
    if (currentFrameRef.current >= durationFrames) {
      setCurrentFrame(0);
    }
    setPlaying(true);
  }, [durationFrames, onEmptyTimeline]);

  const stepFrames = useCallback(
    (delta: number) => {
      setPlaying(false);
      setCurrentFrame((f) => Math.max(0, Math.min(durationFrames, Math.round(f + delta))));
    },
    [durationFrames],
  );

  return {
    currentFrame,
    setCurrentFrame,
    playing,
    setPlaying,
    currentFrameRef,
    playingRef,
    seekTo,
    togglePlay,
    stepFrames,
  };
}

