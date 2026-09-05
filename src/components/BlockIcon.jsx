import React, { useEffect, useState } from 'react';
import {
  Activity, BookOpen, Boxes, CircleGauge, Cpu, FileText, FlaskConical,
  Folder, Landmark, Link, Monitor, Radio, Settings, Shield, Telescope,
  Users, Workflow, PenLine,
} from 'lucide-react';

const FALLBACKS = {
  Activity,
  BookOpen,
  Boxes,
  CircleGauge,
  Cpu,
  FileText,
  FlaskConical,
  Folder,
  Landmark,
  Link,
  Monitor,
  PenLine,
  Radio,
  Settings,
  Shield,
  Telescope,
  Users,
  Workflow,
};

/**
 * A block's icon: its shipped asset when it has one, a Lucide glyph when it
 * does not.
 *
 * Both paths are painted with --icon-accent. They used to diverge: the asset
 * path carried a hardcoded cyan filter chain and the Lucide path carried no
 * colour at all, so it inherited the surrounding text colour and came out
 * near-black on dark chrome. A block that shipped an icon looked right and a
 * block that did not looked broken, which is why this only ever showed up on
 * custom sections.
 */
export function BlockIcon({
  iconAsset,
  iconAssetPng,
  fallback = 'Boxes',
  size = 20,
  className = '',
  style,
}) {
  const [source, setSource] = useState(iconAsset || iconAssetPng || null);

  useEffect(() => {
    setSource(iconAsset || iconAssetPng || null);
  }, [iconAsset, iconAssetPng]);

  const Fallback = FALLBACKS[fallback] || Boxes;
  if (!source) {
    return (
      <Fallback
        size={size}
        className={`block-icon-lucide ${className}`.trim()}
        style={style}
        aria-hidden="true"
      />
    );
  }

  // WHY A SPAN, NOT AN IMG:
  // The SVGs use fill="currentColor". When loaded as <img>, currentColor
  // resolves to black — the img's own black pixels cover the CSS
  // background-color, so the mask's colour-through trick never shows.
  // A <span> has no painted content; background-color + mask works as
  // designed: the accent colour is visible through exactly the icon shape.
  // A hidden <img> is kept solely to trigger onError for the fallback chain.
  const maskUrl = `url("${String(source).replace(/"/g, '\\"')}")`;

  return (
    <>
      <img
        src={source}
        alt=""
        aria-hidden="true"
        style={{ display: 'none', position: 'absolute', pointerEvents: 'none' }}
        onError={() => {
          if (source !== iconAssetPng && iconAssetPng) setSource(iconAssetPng);
          else setSource(null);
        }}
      />
      <span
        aria-hidden="true"
        className={`block-icon-svg ${className}`.trim()}
        style={{
          width: size,
          height: size,
          display: 'block',
          flexShrink: 0,
          WebkitMaskImage: maskUrl,
          maskImage: maskUrl,
          ...style,
        }}
      />
    </>
  );
}

/**
 * The six section icons that ship as assets. A custom group has no asset, so
 * it falls through to a Lucide glyph — which is fine, and is why the
 * fallback had to stop rendering black.
 *
 * This list is the set of files in public/brand/block-icons/sections/. It
 * stays explicit rather than probing at runtime: a missing file would
 * otherwise cost a failed request per render before falling back.
 */
const SECTION_ASSETS = ['finance', 'agent', 'work', 'content', 'tools', 'system'];

/**
 * A custom group names its icon in blockLayout.customGroups[].icon. That
 * value may be a Lucide name, so it is honoured when it matches one — a
 * group called "agents" with icon "Users" gets the Users glyph rather than
 * the generic box. The shipped default is the literal string "custom", which
 * is not a Lucide name and correctly falls through to `fallback`.
 */
export function SectionIcon({ id, size = 16, fallback = 'Boxes', className = '' }) {
  const hasAsset = SECTION_ASSETS.includes(id);
  const lucideName = Object.keys(FALLBACKS).find(
    (k) => k.toLowerCase() === String(id || '').toLowerCase()
  );

  return (
    <BlockIcon
      iconAsset={hasAsset ? `/brand/block-icons/sections/${id}.svg` : null}
      fallback={lucideName || fallback}
      size={size}
      className={className}
    />
  );
}
