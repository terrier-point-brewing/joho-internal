"use client";

import React from "react";

interface GhostCardProps {
  label: string;
  stage: string;
  isRequired: boolean;
  onClick: () => void;
}

function GhostCard({ label, stage, isRequired, onClick }: GhostCardProps) {
  return (
    <div
      onClick={onClick}
      className={`flex-none w-40 rounded-lg border border-dashed cursor-pointer transition-all select-none
        ${isRequired
          ? "border-zinc-600 hover:border-amber-600/50 bg-zinc-900/20 hover:bg-amber-950/10"
          : "border-zinc-700 hover:border-zinc-500 bg-zinc-900/10 hover:bg-zinc-800/20"}`}
    >
      <div className={`h-0.5 w-full rounded-t-lg ${isRequired ? "bg-zinc-700/50" : "bg-zinc-800/30"}`} />
      <div className="p-3 flex flex-col items-start justify-center min-h-[88px] gap-1">
        <span className={`text-[10px] font-bold uppercase tracking-wider ${isRequired ? "text-zinc-500" : "text-zinc-600"}`}>
          {label}
        </span>
        <span className={`text-xs ${isRequired ? "text-zinc-500" : "text-zinc-600"}`}>
          {isRequired ? "Not scheduled" : `+ Add ${label.toLowerCase()}`}
        </span>
        {isRequired && (
          <span className="text-[10px] text-amber-600/60 mt-0.5">⚠ Schedule needed</span>
        )}
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex-none flex items-center w-8">
      <div className="flex-1 border-t border-dashed border-zinc-700" />
      <span className="text-zinc-600 text-sm">›</span>
    </div>
  );
}

export function GhostFlowChain({ onBuild }: { onBuild: () => void }) {
  return (
    <div className="flex items-center gap-0">
      <GhostCard stage="brewhouse"    label="Brewing"      isRequired onClick={onBuild} />
      <Arrow />
      <GhostCard stage="fermenting"   label="Fermenting"   isRequired onClick={onBuild} />
      <Arrow />
      <GhostCard stage="conditioning" label="Conditioning" isRequired onClick={onBuild} />

      {/* Fork connector */}
      <div className="flex-none w-8 flex items-center self-stretch">
        <div className="w-full border-t border-dashed border-zinc-700" />
      </div>
      <div className="flex-none self-stretch border-l border-dashed border-zinc-700" />

      {/* Packaging branches */}
      <div className="flex flex-col gap-3 py-1">
        <div className="flex items-center">
          <div className="w-6 border-t border-dashed border-zinc-700" />
          <span className="text-zinc-600 text-sm mr-0.5">›</span>
          <GhostCard stage="kegging" label="Kegging" isRequired={false} onClick={onBuild} />
        </div>
        <div className="flex items-center">
          <div className="w-6 border-t border-dashed border-zinc-700" />
          <span className="text-zinc-600 text-sm mr-0.5">›</span>
          <GhostCard stage="canning" label="Canning" isRequired={false} onClick={onBuild} />
        </div>
      </div>
    </div>
  );
}
