import React, { useRef, useEffect, useState, Component } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import * as THREE from 'three';

// Create a tight, bright radial glow texture
const createGlowTexture = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.3, 'rgba(255, 255, 255, 1)'); // More intense core
  gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.5)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
};

const createPulseTexture = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  // Smooth spherical falloff (Gaussian-like) instead of a flat disk
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)'); 
  gradient.addColorStop(0.1, 'rgba(255, 255, 255, 0.6)');
  gradient.addColorStop(0.3, 'rgba(255, 255, 255, 0.2)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
};

const GLOW_TEXTURE = createGlowTexture();
const PULSE_TEXTURE = createPulseTexture();

const PULSE_GEOMETRY = new THREE.PlaneGeometry(3, 3);
const PULSE_MATERIAL = new THREE.MeshBasicMaterial({
  map: PULSE_TEXTURE,
  color: 0xffffff,
  transparent: true,
  blending: THREE.AdditiveBlending,
  opacity: 0.6, // Soft center-out glow
  depthWrite: false
});

class GraphErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(e) { return { hasError: true, error: e }; }
  render() {
    if (this.state.hasError) return (
      <div style={{ width:'100%', height:'100%', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', color:'#ff4466', gap:'10px', padding:'20px', textAlign:'center' }}>
        <span style={{ fontSize:'2rem' }}>⚠️</span>
        <p style={{ fontWeight:'bold' }}>Neural Viewport Error</p>
        <pre style={{ fontSize:'0.6rem', opacity:0.6, maxWidth:'380px', overflowX:'auto' }}>{this.state.error?.message}</pre>
      </div>
    );
    return this.props.children;
  }
}

function GraphInner({ data, onNodeClick, width, height, activeNodeIds, isTyping, resetTrigger, fgRef }) {
  const configDone  = useRef(false);
  const typingTimer = useRef(null);
  const [hoverNode, setHoverNode] = useState(null);
  const [highlightNodes, setHighlightNodes] = useState(new Set());
  const [highlightLinks, setHighlightLinks] = useState(new Set());

  // Reset Camera Effect
  useEffect(() => {
    if (fgRef.current && resetTrigger > 0) {
      fgRef.current.zoomToFit(800);
    }
  }, [resetTrigger]);

  useEffect(() => {
    const nodes = new Set();
    const links = new Set();
    if (hoverNode) {
      nodes.add(hoverNode.id);
      data.links.forEach(l => {
        const s = l.source?.id || l.source;
        const t = l.target?.id || l.target;
        if (s === hoverNode.id) { nodes.add(t); links.add(l); }
        else if (t === hoverNode.id) { nodes.add(s); links.add(l); }
      });
    }
    setHighlightNodes(nodes);
    setHighlightLinks(links);
  }, [hoverNode, data]);

  const handleRef = (el) => {
    if (!el) return;
    console.log('--- GRAPH DATA INSPECTION ---');
    console.log('Nodes (first 2):', data?.nodes?.slice(0, 2));
    console.log('Links (first 2):', data?.links?.slice(0, 2));
    console.log('--- GRAPH REF ATTACHED ---', { width, height, nodeCount: data?.nodes?.length });
    if (fgRef) fgRef.current = el;
    if (!configDone.current) {
      configDone.current = true;
      try {
        if (typeof el.d3Force === 'function') {
          const lf = el.d3Force('link');
          const cf = el.d3Force('charge');
          if (lf) lf.distance(18);
          if (cf) cf.strength(-25);
        }
        if (typeof el.d3VelocityDecay === 'function') {
          el.d3VelocityDecay(0.65);
        }
        
        // Ensure camera is looking at the center
        if (typeof el.cameraPosition === 'function') {
          el.cameraPosition({ x: 0, y: 0, z: 120 });
        }
      } catch (e) {
        console.error('Graph config error:', e);
      }
    }
  };

  useEffect(() => {
    if (!fgRef.current || !data?.nodes?.length) return;
    try { if (typeof fgRef.current.d3ReheatSimulation === 'function') fgRef.current.d3ReheatSimulation(); } catch (_) {}
  }, [data]);

  useEffect(() => {
    if (!isTyping) { if (typingTimer.current) clearInterval(typingTimer.current); return; }
    typingTimer.current = setInterval(() => {
      const fg = fgRef.current;
      if (!fg || typeof fg.graphData !== 'function') return;
      const gData = fg.graphData();
      if (!gData?.links?.length) return;
      const l = gData.links[Math.floor(Math.random() * gData.links.length)];
      try { if (typeof fg.emitParticle === 'function') fg.emitParticle(l); } catch (_) {}
    }, 180);
    return () => { if (typingTimer.current) clearInterval(typingTimer.current); };
  }, [isTyping]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || typeof fg.graphData !== 'function' || !activeNodeIds?.size) return;
    const gData = fg.graphData();
    if (!gData?.links) return;
    const hotLinks = gData.links.filter(l => {
      const s = l.source?.id || l.source;
      const t = l.target?.id || l.target;
      return activeNodeIds.has(s) || activeNodeIds.has(t);
    });
    if (!hotLinks.length) return;
    let wave = 0;
    const fire = () => {
      hotLinks.forEach(l => { try { if (typeof fg.emitParticle === 'function') fg.emitParticle(l); } catch (_) {} });
      if (++wave < 8) setTimeout(fire, 250);
    };
    fire();
  }, [activeNodeIds]);

  const isFolderNode = (node) => {
    if (!node) return false;
    const type = node.type || node.nodeType || '';
    const title = node.title || node.name || '';
    return type === 'folder' || type === 'dir' || node.isFolder === true || node.id?.startsWith('folder_') || node.id?.includes('folder') || title.includes('📁');
  };

  const nodeColor = (node) => {
    if (activeNodeIds?.has(node.id)) return '#ffffff';
    if (highlightNodes.has(node.id)) return '#ffffff';
    if (isFolderNode(node)) return '#00ff66';
    return node.color || '#00f2ff';
  };
  
  const nodeSize = (node) => {
    const base = isFolderNode(node) ? 10 : 6;
    if (highlightNodes.has(node.id)) return base * 1.5;
    return activeNodeIds?.has(node.id) ? base * 2.0 : base;
  };

  const linkColor = (link) => {
    const s = link.source?.id || link.source;
    const t = link.target?.id || link.target;
    if (highlightLinks.has(link)) return '#00f2ff';
    if (activeNodeIds?.has(s) || activeNodeIds?.has(t)) return '#ffffff';
    return '#00f2ff'; 
  };

  const linkOpacity = (link) => {
    const s = link.source?.id || link.source;
    const t = link.target?.id || link.target;
    if (highlightLinks.has(link)) return 0.4;
    if (activeNodeIds?.has(s) || activeNodeIds?.has(t)) return 0.6;
    return 0.05;
  };

  return (
    <ForceGraph3D
      ref={handleRef}
      graphData={data}
      width={width}
      height={height}
      backgroundColor="#020508"
      nodeLabel={n => `<div style="padding: 8px; border-left: 3px solid ${nodeColor(n)}; background: rgba(0,0,0,0.95); font-family: 'JetBrains Mono'; font-size: 0.75rem; border-radius: 4px; box-shadow: 0 4px 15px rgba(0,0,0,0.5);">
        <div style="color: ${nodeColor(n)}; font-weight: bold; letter-spacing: 1px;">${n.title}</div>
        <div style="color: rgba(255,255,255,0.4); font-size: 0.65rem; margin-top: 4px;">CLUSTER: ${n.cluster?.toUpperCase()}</div>
      </div>`}
      nodeThreeObject={node => {
        const size = nodeSize(node) || 5;
        const geometry = new THREE.SphereGeometry(size, 16, 16);
        const material = new THREE.MeshBasicMaterial({ color: nodeColor(node) });
        return new THREE.Mesh(geometry, material);
      }}
      linkColor={linkColor}
      linkWidth={0.4}
      linkMaterial={link => new THREE.MeshBasicMaterial({ 
        color: linkColor(link), 
        transparent: true, 
        blending: THREE.AdditiveBlending,
        opacity: linkOpacity(link), // Use separate opacity function
        depthWrite: false 
      })}
      linkCurvature={0.3}
      linkOpacity={1}
      linkDirectionalParticles={1}
      linkDirectionalParticleSpeed={0.003}
      linkDirectionalParticleThreeObject={() => {
        // Custom Billboard Mesh: Acts like a Sprite for perfect gradients, but won't crash the engine
        const mesh = new THREE.Mesh(PULSE_GEOMETRY, PULSE_MATERIAL);
        mesh.onBeforeRender = function(renderer, scene, camera) {
          this.quaternion.copy(camera.quaternion);
        };
        return mesh;
      }}
      onNodeClick={onNodeClick}
      onNodeHover={node => setHoverNode(node)}
      warmupTicks={100}
      cooldownTicks={150}
      enableNodeDrag={false}
      showNavInfo={false}
    />
  );
}

export default function NeuronViewport({ data, onNodeClick, activeNodeIds, isTyping, resetTrigger }) {
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  const [dims, setDims] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);

  useEffect(() => {
    if (graphRef.current && resetTrigger > 0) {
      graphRef.current.zoomToFit(600);
    }
  }, [resetTrigger]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const query = searchQuery.toLowerCase();
    const results = (data?.nodes || []).filter(n => {
      const text = (n.title || n.name || n.id || '').toLowerCase();
      return text.includes(query);
    }).slice(0, 8);
    setSearchResults(results);
  }, [searchQuery, data]);

  const handleResultClick = (node) => {
    setSearchQuery('');
    setSearchResults([]);
    
    if (graphRef.current) {
      // If physics simulation has given it coordinates, fly there
      if (node.x !== undefined && node.y !== undefined && node.z !== undefined) {
        // Move camera to a slight offset from the node so it stays in view
        const distance = 80;
        const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);
        graphRef.current.cameraPosition(
          { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
          node, // lookAt
          1200  // ms transition duration
        );
      }
    }
    
    if (onNodeClick) onNodeClick(node);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w > 50 && h > 50) {
        setDims(prev => {
          if (prev && prev.width === w && prev.height === h) return prev;
          return { width: w, height: h };
        });
      }
    };

    measure();
    const t1 = setTimeout(measure, 100);
    const t2 = setTimeout(measure, 500);
    const t3 = setTimeout(measure, 1000);

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="neuron-viewport-root"
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      {/* Search Overlay */}
      <div style={{ position: 'absolute', top: '20px', left: '20px', zIndex: 10, width: 'min(320px, calc(100% - 40px))', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <input
          type="text"
          placeholder="Search matrix nodes..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{ 
            width: '100%', padding: '12px 16px', borderRadius: '8px', 
            border: '1px solid rgba(0, 242, 255, 0.4)', 
            background: 'rgba(0, 0, 0, 0.7)', color: '#fff', 
            fontSize: '0.85rem', fontFamily: 'JetBrains Mono, monospace', 
            outline: 'none', backdropFilter: 'blur(10px)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)'
          }}
        />
        {searchResults.length > 0 && (
          <div style={{ 
            background: 'rgba(0, 0, 0, 0.85)', border: '1px solid rgba(0, 242, 255, 0.3)', 
            borderRadius: '8px', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px', 
            backdropFilter: 'blur(10px)', maxHeight: '400px', overflowY: 'auto',
            boxShadow: '0 8px 30px rgba(0,0,0,0.7)'
          }}>
            {searchResults.map(res => (
              <div
                key={res.id}
                onClick={() => handleResultClick(res)}
                style={{ 
                  padding: '10px 12px', color: 'rgba(255,255,255,0.9)', 
                  fontSize: '0.75rem', cursor: 'pointer', borderRadius: '4px', 
                  borderLeft: `3px solid ${res.color || '#00f2ff'}`, 
                  background: 'rgba(255,255,255,0.03)', transition: 'background 0.2s',
                  fontFamily: 'JetBrains Mono, monospace'
                }}
                onMouseEnter={e => e.target.style.background = 'rgba(255,255,255,0.1)'}
                onMouseLeave={e => e.target.style.background = 'rgba(255,255,255,0.03)'}
              >
                {res.title || res.name || res.id}
              </div>
            ))}
          </div>
        )}
      </div>

      {dims ? (
        <GraphErrorBoundary>
          <GraphInner
            data={data} onNodeClick={onNodeClick}
            width={dims.width} height={dims.height}
            activeNodeIds={activeNodeIds} isTyping={isTyping}
            resetTrigger={resetTrigger}
            fgRef={graphRef}
          />
        </GraphErrorBoundary>
      ) : (
        <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:'rgba(0,242,255,0.25)', fontSize:'0.7rem', letterSpacing:'3px' }}>
          CALIBRATING...
        </div>
      )}
    </div>
  );
}
