// The supplied mark is redrawn as two flat paths, without its raster tile or shadow.
export const BRAND_MARK_PATHS=Object.freeze(['M115 104 190 52v121l-17 14v52l-58 55Z','M57 349 378 130 211 274h120l-44 45H133l80-64Z']);
export function brandMarkSvg(fill='#203c38'){
  const safe=/^#[0-9a-f]{6}$/i.test(fill)?fill:'#203c38';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="40 40 350 320" fill="${safe}">${BRAND_MARK_PATHS.map(d=>`<path d="${d}"/>`).join('')}</svg>`;
}
