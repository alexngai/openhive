/**
 * NodeSquareProgram — Custom sigma.js WebGL node program that renders squares.
 *
 * Based on sigma's NodePointProgram (gl.POINTS) which already renders a square
 * pixel region per node. We replace the fragment shader's circle distance check
 * (length) with a box distance check (max of abs).
 */

import { NodePointProgram } from 'sigma/rendering';

const SQUARE_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;

varying vec4 v_color;
varying float v_border;

const float radius = 0.5;
const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);

void main(void) {
  vec2 m = gl_PointCoord - vec2(0.5, 0.5);
  float dist = radius - max(abs(m.x), abs(m.y));

  #ifdef PICKING_MODE
  if (dist > v_border)
    gl_FragColor = v_color;
  else
    gl_FragColor = transparent;
  #else
  float t = 0.0;
  if (dist > v_border)
    t = 1.0;
  else if (dist > 0.0)
    t = dist / v_border;

  gl_FragColor = mix(transparent, v_color, t);
  #endif
}
`;

export default class NodeSquareProgram extends NodePointProgram {
  getDefinition() {
    const def = super.getDefinition();
    return {
      ...def,
      FRAGMENT_SHADER_SOURCE: SQUARE_FRAGMENT_SHADER,
    };
  }
}
