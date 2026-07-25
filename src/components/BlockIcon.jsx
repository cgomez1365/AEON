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

export function BlockIcon({
  iconAsset,
  iconAssetPng,
  fallback = 'Boxes',
  size = 20,
  className = '',
}) {
  const [source, setSource] = useState(iconAsset || iconAssetPng || null);

  useEffect(() => {
    setSource(iconAsset || iconAssetPng || null);
  }, [iconAsset, iconAssetPng]);

  const Fallback = FALLBACKS[fallback] || Boxes;
  if (!source) return <Fallback size={size} className={className} aria-hidden="true" />;

  return (
    <img
      src={source}
      alt=""
      aria-hidden="true"
      className={`block-icon-svg ${className}`.trim()}
      width={size}
      height={size}
      onError={() => {
        if (source !== iconAssetPng && iconAssetPng) setSource(iconAssetPng);
        else setSource(null);
      }}
    />
  );
}

export function SectionIcon({ id, size = 16, fallback = 'Boxes', className = '' }) {
  const supported = ['finance', 'agent', 'work', 'content', 'tools', 'system'].includes(id);
  return (
    <BlockIcon
      iconAsset={supported ? `/brand/block-icons/sections/${id}.svg` : null}
      fallback={fallback}
      size={size}
      className={className}
    />
  );
}
