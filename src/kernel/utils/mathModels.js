// Highly detailed image-based models (Depth Maps)
export const STATIC_MODELS = [
  { id: 'randomizer', name: 'Randomizer (Morph Session)' },
  
  // Original 8
  { id: 'beast', name: 'Original Beast' },
  { id: 'skull', name: 'Original Skull' },
  { id: 'bird', name: 'Original Bird' },
  { id: 'lion', name: 'Original Lion' },
  { id: 'eyes', name: 'Original Eyes' },
  { id: 'ascended', name: 'Original Ascended' },
  { id: 'flower', name: 'Original Flower' },
  { id: 'butterfly', name: 'Original Butterfly' },
  
  // New 16 High-Detail AI Generated
  { id: 'flower_rose', name: 'Rose Depth Map' },
  { id: 'flower_lotus', name: 'Lotus Depth Map' },
  { id: 'flower_sunflower', name: 'Sunflower Depth Map' },
  { id: 'flower_orchid', name: 'Orchid Depth Map' },
  { id: 'flower_dandelion', name: 'Dandelion Depth Map' },
  { id: 'flower_lily', name: 'Lily Depth Map' },
  { id: 'flower_tulip', name: 'Tulip Depth Map' },
  { id: 'flower_daisy', name: 'Daisy Depth Map' },
  { id: 'flower_hibiscus', name: 'Hibiscus Depth Map' },
  { id: 'flower_sakura', name: 'Sakura Depth Map' },
  { id: 'myth_dragon', name: 'Dragon Depth Map' },
  { id: 'myth_phoenix', name: 'Phoenix Depth Map' },
  { id: 'myth_griffin', name: 'Griffin Depth Map' },
  { id: 'myth_unicorn', name: 'Unicorn Depth Map' },
  { id: 'myth_pegasus', name: 'Pegasus Depth Map' },
  { id: 'animal_wolf', name: 'Wolf Depth Map' }
];

// No more math models. All are image-based.
export function generateModel(modelId, numPoints) {
  // Fallback if needed, but not used since we load images.
  const pos = new Float32Array(numPoints * 3);
  const PI = Math.PI;
  for (let i = 0; i < numPoints; i++) {
    const theta = Math.random() * PI * 2;
    const ph = Math.acos(Math.random() * 2 - 1);
    const r = 4.0;
    pos[i*3] = r * Math.sin(ph) * Math.cos(theta);
    pos[i*3+1] = r * Math.sin(ph) * Math.sin(theta);
    pos[i*3+2] = r * Math.cos(ph);
  }
  return pos;
}
