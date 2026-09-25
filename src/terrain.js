// Terrain mesh: a regular grid displaced by elevation and textured with the map.

import * as THREE from 'three';

export class Terrain {
  /**
   * @param frame     LocalFrame
   * @param bbox      Mercator bbox covered by the terrain
   * @param elevation sampler with heightAt(mercX, mercY)
   * @param spacing   approximate grid spacing in metres
   */
  constructor(frame, bbox, elevation, spacing = 5) {
    const a = frame.toLocal(bbox.minX, bbox.maxY); // north-west corner
    const b = frame.toLocal(bbox.maxX, bbox.minY); // south-east corner
    this.x0 = a.x;
    this.z0 = a.z;
    this.width = b.x - a.x;
    this.depth = b.z - a.z;
    this.nx = Math.min(600, Math.max(16, Math.round(this.width / spacing)));
    this.nz = Math.min(600, Math.max(16, Math.round(this.depth / spacing)));

    const count = (this.nx + 1) * (this.nz + 1);
    this.base = new Float32Array(count);
    const positions = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    let i = 0;
    for (let j = 0; j <= this.nz; j++) {
      for (let k = 0; k <= this.nx; k++, i++) {
        const x = this.x0 + (k / this.nx) * this.width;
        const z = this.z0 + (j / this.nz) * this.depth;
        const m = frame.toMerc(x, z);
        this.base[i] = elevation.heightAt(m.x, m.y);
        positions[i * 3] = x;
        positions[i * 3 + 2] = z;
        uvs[i * 2] = k / this.nx;
        uvs[i * 2 + 1] = 1 - j / this.nz; // row 0 is north = top of the map image
      }
    }

    const indices = [];
    for (let j = 0; j < this.nz; j++) {
      for (let k = 0; k < this.nx; k++) {
        const p = j * (this.nx + 1) + k;
        const q = p + this.nx + 1;
        indices.push(p, q, p + 1, p + 1, q, q + 1);
      }
    }

    this.minHeight = this.base.reduce((m, v) => Math.min(m, v), Infinity);
    this.maxHeight = this.base.reduce((m, v) => Math.max(m, v), -Infinity);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(indices);

    // Polygon offset pushes the terrain slightly back so the route line
    // lying on it wins the depth test.
    const common = { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
    this.shadedMaterial = new THREE.MeshStandardMaterial({ ...common, roughness: 1, metalness: 0 });
    this.flatMaterial = new THREE.MeshBasicMaterial(common);
    this.mesh = new THREE.Mesh(this.geometry, this.shadedMaterial);
  }

  setTexture(texture) {
    for (const m of [this.shadedMaterial, this.flatMaterial]) {
      m.map?.dispose();
      m.map = texture;
      m.needsUpdate = true;
    }
  }

  setShaded(shaded) {
    this.mesh.material = shaded ? this.shadedMaterial : this.flatMaterial;
  }

  setWireframe(on) {
    this.shadedMaterial.wireframe = on;
    this.flatMaterial.wireframe = on;
  }

  /** Scene y for a real elevation, given vertical exaggeration. */
  sceneY(height, exaggeration) {
    return (height - this.minHeight) * exaggeration;
  }

  setExaggeration(exaggeration) {
    const pos = this.geometry.attributes.position;
    for (let i = 0; i < this.base.length; i++) {
      pos.array[i * 3 + 1] = this.sceneY(this.base[i], exaggeration);
    }
    pos.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
  }

  dispose() {
    this.geometry.dispose();
    this.shadedMaterial.map?.dispose();
    this.shadedMaterial.dispose();
    this.flatMaterial.dispose();
  }
}
