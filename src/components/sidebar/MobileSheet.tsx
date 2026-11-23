import React, { useRef } from 'react';
import type { SkiResort, MobileSheetState, PanelView, TrailInspectionData } from '../../types';
import { formatVert, formatSnow } from '../../utils/formatters';

interface MobileSheetProps {
  mobileSheetState: MobileSheetState;
  onSetMobileSheetState: (state: MobileSheetState | ((prev: MobileSheetState) => MobileSheetState)) => void;
  selectedResort: SkiResort | null;
  selectedTrail?: TrailInspectionData | null;
  panelView: PanelView;
  filteredResortsCount: number;
  inViewResortsCount: number;
  activeFiltersCount: number;
  unitsMetric: boolean;
  children: React.ReactNode;
}

export const MobileSheet: React.FC<MobileSheetProps> = ({
  mobileSheetState,
  onSetMobileSheetState,
  selectedResort,
  selectedTrail,
  filteredResortsCount: _filteredResortsCount,
  inViewResortsCount,
  unitsMetric,
  children,
}) => {
  const touchStartY = useRef<number | null>(null);
  const touchCurrentY = useRef<number | null>(null);
  const touchStartTime = useRef<number | null>(null);
  const isDragging = useRef<boolean>(false);
  const [dragOffset, setDragOffset] = React.useState<number>(0);
  const [isSwiping, setIsSwiping] = React.useState<boolean>(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    touchCurrentY.current = e.touches[0].clientY;
    touchStartTime.current = performance.now();
    isDragging.current = false;
    setIsSwiping(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current === null) return;
    touchCurrentY.current = e.touches[0].clientY;
    const dy = touchCurrentY.current - touchStartY.current;

    if (Math.abs(dy) > 5) {
      isDragging.current = true;
    }

    if (mobileSheetState === 'full') {
      // Swiping down: sheet follows finger smoothly (clamped to positive dy)
      // Allow a tiny rubber band if dragged up (< 0)
      if (dy > 0) {
        setDragOffset(dy);
      } else {
        setDragOffset(dy * 0.15); // gentle resistance upwards
      }
    } else {
      // Swiping up from peek
      if (dy < 0) {
        setDragOffset(dy);
      } else {
        setDragOffset(dy * 0.15);
      }
    }
  };

  const handleTouchEnd = () => {
    setIsSwiping(false);
    const startY = touchStartY.current;
    const currentY = touchCurrentY.current;
    const startTime = touchStartTime.current;

    touchStartY.current = null;
    touchCurrentY.current = null;
    touchStartTime.current = null;
    setDragOffset(0);

    if (startY === null || currentY === null) {
      isDragging.current = false;
      return;
    }

    const dy = currentY - startY;
    const dt = Math.max(1, performance.now() - (startTime ?? performance.now()));
    const velocity = dy / dt; // px/ms (negative = upward swipe, positive = downward swipe)
    const windowH = typeof window !== 'undefined' ? window.innerHeight : 800;
    const heightThreshold = windowH * 0.25;

    // Responsive 2-state drawer: snap between 'peek' and 'full' based on velocity (>0.3 px/ms) or 25% height threshold
    if (mobileSheetState === 'peek') {
      // Swiping up from peek expands to full
      if (velocity < -0.3 || dy < -heightThreshold || dy < -30) {
        onSetMobileSheetState('full');
      }
    } else {
      // Swiping down from full collapses to peek
      if (velocity > 0.3 || dy > heightThreshold || dy > 40) {
        onSetMobileSheetState('peek');
      }
    }

    setTimeout(() => {
      isDragging.current = false;
    }, 60);
  };

  const handleHandleClick = () => {
    if (isDragging.current) return;
    // Tap drag handle toggles sheet state
    onSetMobileSheetState((prev) => (prev === 'peek' ? 'full' : 'peek'));
  };

  const handlePeekClick = () => {
    if (isDragging.current) return;
    // Single tap on collapsed floating pill directly expands to full
    onSetMobileSheetState('full');
  };

  const isFull = mobileSheetState === 'full';

  // Compute transform style for live 1:1 finger tracking
  const sheetTransform = isFull
    ? isSwiping && dragOffset > 0
      ? `translate3d(0, ${dragOffset}px, 0)`
      : 'translate3d(0, 0, 0)'
    : 'translate3d(0, 100%, 0)';

  return (
    <>
      {/* 1. COLLAPSED FLOATING PEEK PILL (Visible when peek, hides when full) */}
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={handlePeekClick}
        className={`md:hidden fixed bottom-0 left-1/2 -translate-x-1/2 z-30 h-11 px-4 mb-[calc(max(12px,env(safe-area-inset-bottom,0px)))] bg-[#FAF8F3] border border-[#2C2A27] rounded-full shadow-[0_4px_20px_rgba(0,0,0,0.18)] flex items-center justify-between gap-3 cursor-pointer select-none max-w-[calc(100vw-24px)] whitespace-nowrap active:scale-98 transition-all duration-200 ${
          isFull
            ? 'opacity-0 translate-y-6 pointer-events-none'
            : 'opacity-100 translate-y-0 pointer-events-auto'
        }`}
        role="button"
        aria-label={
          selectedResort
            ? `View details for ${selectedResort.name}`
            : selectedTrail
            ? `View details for ${selectedTrail.name}`
            : `View ${inViewResortsCount.toLocaleString()} ski areas in view`
        }
      >
        {selectedResort ? (
          <div className="flex items-center gap-1.5 min-w-0 truncate">
            <span className="font-bold text-xs text-[#1C1B18] truncate max-w-[130px] xs:max-w-[180px] sm:max-w-[240px]">
              {selectedResort.name}
            </span>
            {(() => {
              const parts = [
                selectedResort.vertical_drop_ft && selectedResort.vertical_drop_ft > 0
                  ? formatVert(selectedResort.vertical_drop_ft, unitsMetric)
                  : null,
                selectedResort.weather?.snowfall_7d_in
                  ? `${formatSnow(selectedResort.weather.snowfall_7d_in, unitsMetric)} 7d`
                  : null,
              ].filter(Boolean);
              return parts.length > 0 ? (
                <span className="text-[11px] font-semibold text-[#5C5852] shrink-0">
                  · {parts.join(' · ')}
                </span>
              ) : null;
            })()}
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#B84A39] bg-[#EFECE4] border border-[#D6D0C2] px-1.5 py-0.5 rounded shrink-0 ml-1">
              Details ↑
            </span>
          </div>
        ) : selectedTrail ? (
          <div className="flex items-center gap-1.5 min-w-0 truncate">
            <span className="font-bold text-xs text-[#1C1B18] truncate max-w-[130px] xs:max-w-[180px] sm:max-w-[240px]">
              {selectedTrail.name}
            </span>
            {selectedTrail.verticalDropFt && selectedTrail.verticalDropFt > 0 && (
              <span className="text-[11px] font-semibold text-[#5C5852] shrink-0">
                · {formatVert(selectedTrail.verticalDropFt, unitsMetric)}
              </span>
            )}
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#B84A39] bg-[#EFECE4] border border-[#D6D0C2] px-1.5 py-0.5 rounded shrink-0 ml-1">
              Details ↑
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs font-bold text-[#1C1B18]">
            <span className="text-[#B84A39] text-[10px]">▲</span>
            <span>{inViewResortsCount.toLocaleString()} in view · Directory</span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#5C5852] bg-[#EFECE4] px-1.5 py-0.5 rounded border border-[#D6D0C2] shrink-0 ml-1">
              ↑
            </span>
          </div>
        )}
      </div>

      {/* 2. EXPANDED MOUNTAIN DIRECTORY & PROFILE (SLIDES UP FROM OFF-SCREEN BOTTOM) */}
      <div
        style={{
          transform: sheetTransform,
          transition: isSwiping ? 'none' : 'transform 240ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}
        className={`md:hidden fixed inset-x-0 bottom-0 z-30 flex flex-col bg-[#F7F4ED] rounded-t-2xl border-t border-[#D6D0C2] shadow-[0_-4px_24px_rgba(0,0,0,0.2)] pb-[max(12px,env(safe-area-inset-bottom,0px))] h-[88dvh] max-h-[calc(100dvh-16px)] min-h-[280px] will-change-transform ${
          isFull ? 'pointer-events-auto' : 'pointer-events-none'
        }`}
        aria-hidden={!isFull}
      >
        {/* Pull tab / Drag handle pill with touch gesture support */}
        <div
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onClick={handleHandleClick}
          className="w-full py-3 flex items-center justify-center cursor-pointer shrink-0 select-none touch-none active:opacity-70"
          title="Swipe down or tap to collapse"
        >
          <div className="w-10 h-1.5 rounded-full bg-[#C4BEB1] hover:bg-[#8A847C] transition-colors" />
        </div>

        {/* Scrollable Content inside sheet */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col relative">
          {children}
        </div>
      </div>
    </>
  );
};
