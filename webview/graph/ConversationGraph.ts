/**
 * ConversationGraph — SVG graph rendering engine.
 * Ported from vscode-git-graph/web/graph.ts, adapted for conversation nodes.
 *
 * Architecture: Branch → Vertex → Graph (3-class layout engine)
 * Each GraphNode (user message) maps to a Vertex; branches are drawn as
 * SVG <path> elements with color-coded lines and <circle> nodes.
 */

import type { GraphNode, BranchGraphData } from "../../src/types/branch-graph";

// ============================================================
// Configuration
// ============================================================

export interface GraphConfig {
  grid: {
    x: number;       // horizontal spacing between branches
    y: number;       // vertical spacing between rows
    offsetX: number;  // left margin for SVG
    offsetY: number;  // top margin for SVG
  };
  colours: string[];
  style: GraphStyle;
}

export enum GraphStyle {
  Angular = 0,
  Curved = 1,
}

const DEFAULT_COLOURS = [
  "#0085d9",  // blue
  "#d9534f",  // red
  "#2ca02c",  // green
  "#ff7f0e",  // orange
  "#9467bd",  // purple
  "#17becf",  // cyan
  "#e377c2",  // pink
  "#bcbd22",  // yellow-green
];

export const DEFAULT_CONFIG: GraphConfig = {
  grid: { x: 16, y: 24, offsetX: 8, offsetY: 42 },
  colours: DEFAULT_COLOURS,
  style: GraphStyle.Curved,
};

// ============================================================
// Internal types
// ============================================================

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Line {
  readonly p1: Point;
  readonly p2: Point;
  readonly lockedFirst: boolean;
}

interface Pixel {
  x: number;
  y: number;
}

interface PlacedLine {
  readonly p1: Pixel;
  readonly p2: Pixel;
  readonly lockedFirst: boolean;
}

interface UnavailablePoint {
  readonly connectsTo: Vertex | null;
  readonly onBranch: Branch;
}

// ============================================================
// Branch class
// ============================================================

class Branch {
  private readonly colour: number;
  private end = 0;
  private lines: Line[] = [];

  constructor(colour: number) {
    this.colour = colour;
  }

  addLine(p1: Point, p2: Point, lockedFirst: boolean): void {
    this.lines.push({ p1, p2, lockedFirst });
  }

  getColour(): number {
    return this.colour;
  }

  getEnd(): number {
    return this.end;
  }

  setEnd(end: number): void {
    this.end = end;
  }

  /**
   * Generate SVG path markup for this branch's lines.
   */
  renderPaths(config: GraphConfig): string {
    const colour = config.colours[this.colour % config.colours.length];
    const d = config.grid.y * (config.style === GraphStyle.Angular ? 0.38 : 0.8);
    let html = "";

    // Convert logical lines to pixel coords
    const placed: PlacedLine[] = [];
    for (const line of this.lines) {
      const x1 = line.p1.x * config.grid.x + config.grid.offsetX;
      const y1 = line.p1.y * config.grid.y + config.grid.offsetY;
      const x2 = line.p2.x * config.grid.x + config.grid.offsetX;
      const y2 = line.p2.y * config.grid.y + config.grid.offsetY;
      placed.push({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, lockedFirst: line.lockedFirst });
    }

    // Simplify consecutive vertical lines
    let i = 0;
    while (i < placed.length - 1) {
      const cur = placed[i];
      const next = placed[i + 1];
      if (
        cur.p1.x === cur.p2.x &&
        cur.p2.x === next.p1.x &&
        next.p1.x === next.p2.x &&
        cur.p2.y === next.p1.y
      ) {
        cur.p2.y = next.p2.y;
        placed.splice(i + 1, 1);
      } else {
        i++;
      }
    }

    // Build SVG path string
    let curPath = "";
    for (i = 0; i < placed.length; i++) {
      const line = placed[i];
      const { x: x1, y: y1 } = line.p1;
      const { x: x2, y: y2 } = line.p2;

      if (curPath === "" || (i > 0 && (x1 !== placed[i - 1].p2.x || y1 !== placed[i - 1].p2.y))) {
        curPath += `M${x1.toFixed(0)},${y1.toFixed(1)}`;
      }

      if (x1 === x2) {
        curPath += `L${x2.toFixed(0)},${y2.toFixed(1)}`;
      } else if (config.style === GraphStyle.Angular) {
        const mid = line.lockedFirst
          ? `${x2.toFixed(0)},${(y2 - d).toFixed(1)}`
          : `${x1.toFixed(0)},${(y1 + d).toFixed(1)}`;
        curPath += `L${mid}L${x2.toFixed(0)},${y2.toFixed(1)}`;
      } else {
        curPath += `C${x1.toFixed(0)},${(y1 + d).toFixed(1)} ${x2.toFixed(0)},${(y2 - d).toFixed(1)} ${x2.toFixed(0)},${y2.toFixed(1)}`;
      }
    }

    if (curPath) {
      html += `<path class="shadow" d="${curPath}"/>`;
      html += `<path class="line" d="${curPath}" stroke="${colour}"/>`;
    }

    return html;
  }
}

// ============================================================
// Vertex class
// ============================================================

class Vertex {
  readonly id: number;
  private x = 0;
  private children: Vertex[] = [];
  private parents: Vertex[] = [];
  private nextParent = 0;
  private onBranch: Branch | null = null;
  private isCurrent_ = false;
  private nextX = 0;
  private connections: UnavailablePoint[] = [];

  constructor(id: number) {
    this.id = id;
  }

  addChild(v: Vertex): void { this.children.push(v); }
  getChildren(): readonly Vertex[] { return this.children; }
  addParent(v: Vertex): void { this.parents.push(v); }
  getParents(): readonly Vertex[] { return this.parents; }
  hasParents(): boolean { return this.parents.length > 0; }

  getNextParent(): Vertex | null {
    return this.nextParent < this.parents.length ? this.parents[this.nextParent] : null;
  }

  registerParentProcessed(): void { this.nextParent++; }
  isMerge(): boolean { return this.parents.length > 1; }

  addToBranch(branch: Branch, x: number): void {
    if (this.onBranch === null) {
      this.onBranch = branch;
      this.x = x;
    }
  }

  isNotOnBranch(): boolean { return this.onBranch === null; }
  isOnThisBranch(branch: Branch): boolean { return this.onBranch === branch; }
  getBranch(): Branch | null { return this.onBranch; }

  getPoint(): Point { return { x: this.x, y: this.id }; }
  getNextPoint(): Point { return { x: this.nextX, y: this.id }; }

  getPointConnectingTo(vertex: Vertex | null, onBranch: Branch): Point | null {
    for (let i = 0; i < this.connections.length; i++) {
      if (this.connections[i].connectsTo === vertex && this.connections[i].onBranch === onBranch) {
        return { x: i, y: this.id };
      }
    }
    return null;
  }

  registerUnavailablePoint(x: number, connectsTo: Vertex | null, onBranch: Branch): void {
    if (x === this.nextX) {
      this.nextX = x + 1;
      this.connections[x] = { connectsTo, onBranch };
    }
  }

  getColour(): number {
    return this.onBranch !== null ? this.onBranch.getColour() : 0;
  }

  setCurrent(): void { this.isCurrent_ = true; }

  /**
   * Generate SVG circle markup for this vertex.
   */
  renderCircle(config: GraphConfig): string {
    if (this.onBranch === null) return "";
    const colour = config.colours[this.onBranch.getColour() % config.colours.length];
    const cx = this.x * config.grid.x + config.grid.offsetX;
    const cy = this.id * config.grid.y + config.grid.offsetY;

    if (this.isCurrent_) {
      return `<circle data-id="${this.id}" cx="${cx}" cy="${cy}" r="5" class="current" stroke="${colour}" fill="none" stroke-width="2"/>`;
    }
    return `<circle data-id="${this.id}" cx="${cx}" cy="${cy}" r="4" fill="${colour}"/>`;
  }
}

// ============================================================
// ConversationGraph class
// ============================================================

export interface GraphRenderResult {
  svgContent: string;
  width: number;
  height: number;
  /** Colour index for each node row (for table row colour indicators) */
  vertexColours: number[];
  /** Pixel width of graph at each row (for table column sizing) */
  widthsAtVertices: number[];
}

const NULL_VERTEX_ID = -1;

export class ConversationGraph {
  private config: GraphConfig;
  private vertices: Vertex[] = [];
  private branches: Branch[] = [];
  private availableColours: number[] = [];

  /** Visible branch filter — null means show all */
  private visibleBranches: Set<string> | null = null;

  constructor(config?: Partial<GraphConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set which branches to render. Pass null to show all.
   */
  setVisibleBranches(sessionIds: string[] | null): void {
    this.visibleBranches = sessionIds ? new Set(sessionIds) : null;
  }

  /**
   * Load nodes from a BranchGraphData and build the internal vertex/branch graph.
   */
  loadNodes(data: BranchGraphData): void {
    this.vertices = [];
    this.branches = [];
    this.availableColours = [];

    // Filter nodes by visible branches
    let nodes = data.nodes;
    if (this.visibleBranches) {
      nodes = nodes.filter((n) => this.visibleBranches!.has(n.sessionId));
    }

    if (nodes.length === 0) return;

    // Sort nodes DESCENDING by id (newest first) — the layout algorithm
    // from vscode-git-graph assumes children come before parents in the array.
    // The inner loop in determinePath scans forward from startAt+1 to find
    // parent vertices, so parents MUST be at higher indices.
    nodes = [...nodes].sort((a, b) => b.id - a.id);

    // Build id → sequential index mapping
    const idToIndex = new Map<number, number>();
    for (let i = 0; i < nodes.length; i++) {
      idToIndex.set(nodes[i].id, i);
    }

    // Create vertices
    const nullVertex = new Vertex(NULL_VERTEX_ID);
    for (let i = 0; i < nodes.length; i++) {
      this.vertices.push(new Vertex(i));
    }

    // Build parent/child relationships
    for (let i = 0; i < nodes.length; i++) {
      for (const parentId of nodes[i].parentIds) {
        const parentIdx = idToIndex.get(parentId);
        if (parentIdx !== undefined) {
          this.vertices[i].addParent(this.vertices[parentIdx]);
          this.vertices[parentIdx].addChild(this.vertices[i]);
        } else {
          // Parent not in visible set
          this.vertices[i].addParent(nullVertex);
        }
      }
    }

    // Mark current nodes
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].isCurrent) {
        this.vertices[i].setCurrent();
      }
    }

    // Log fork points (vertices with 2+ children)
    const forkVertices = this.vertices.filter((_, k) => this.vertices[k].getChildren().length > 1);
    console.log(`[ConversationGraph] ${this.vertices.length} vertices, ${forkVertices.length} fork points`);
    for (const fv of forkVertices) {
      console.log(`[ConversationGraph] Fork vertex id=${fv.id}, children=${fv.getChildren().length}, parents=${fv.getParents().length}`);
    }

    // Log sorted node info (first 5 and last 3)
    for (let k = 0; k < Math.min(5, nodes.length); k++) {
      console.log(`[ConversationGraph] Sorted[${k}]: origId=${nodes[k].id}, branch="${nodes[k].branchName}", parentIds=[${nodes[k].parentIds}]`);
    }
    if (nodes.length > 5) {
      for (let k = Math.max(5, nodes.length - 3); k < nodes.length; k++) {
        console.log(`[ConversationGraph] Sorted[${k}]: origId=${nodes[k].id}, branch="${nodes[k].branchName}", parentIds=[${nodes[k].parentIds}]`);
      }
    }

    // Run layout algorithm
    let i = 0;
    let iterations = 0;
    const maxIterations = this.vertices.length * this.vertices.length + 100;
    while (i < this.vertices.length) {
      if (++iterations > maxIterations) {
        console.error("[ConversationGraph] Layout exceeded max iterations, aborting");
        break;
      }
      if (this.vertices[i].getNextParent() !== null || this.vertices[i].isNotOnBranch()) {
        this.determinePath(i);
      } else {
        i++;
      }
    }

    // Log layout result: branch count and x-positions
    const xPositions = new Set<number>();
    for (const v of this.vertices) {
      xPositions.add(v.getPoint().x);
    }
    console.log(`[ConversationGraph] Layout done: ${this.branches.length} branches, x-columns: [${[...xPositions].sort((a,b)=>a-b)}]`);
    for (let b = 0; b < this.branches.length; b++) {
      console.log(`[ConversationGraph] Branch ${b}: colour=${this.branches[b].getColour()}`);
    }
  }

  /**
   * Render the graph to SVG markup.
   */
  render(): GraphRenderResult {
    console.log(`[ConversationGraph] Rendering: ${this.branches.length} branches, ${this.vertices.length} vertices, width=${this.getContentWidth()}`);

    let svgContent = "";

    // Draw branch lines
    for (const branch of this.branches) {
      svgContent += branch.renderPaths(this.config);
    }

    // Draw vertex circles (on top of lines)
    for (const vertex of this.vertices) {
      svgContent += vertex.renderCircle(this.config);
    }

    const width = this.getContentWidth();
    const height = this.getHeight();

    return {
      svgContent,
      width,
      height,
      vertexColours: this.getVertexColours(),
      widthsAtVertices: this.getWidthsAtVertices(),
    };
  }

  private getContentWidth(): number {
    let maxX = 0;
    for (const v of this.vertices) {
      const p = v.getNextPoint();
      if (p.x > maxX) maxX = p.x;
    }
    return 2 * this.config.grid.offsetX + Math.max(0, maxX - 1) * this.config.grid.x;
  }

  private getHeight(): number {
    return this.vertices.length * this.config.grid.y +
      this.config.grid.offsetY -
      this.config.grid.y / 2;
  }

  private getVertexColours(): number[] {
    return this.vertices.map((v) => v.getColour() % this.config.colours.length);
  }

  private getWidthsAtVertices(): number[] {
    return this.vertices.map((v) =>
      this.config.grid.offsetX + v.getNextPoint().x * this.config.grid.x - 2
    );
  }

  // ============================================================
  // Core layout algorithm (ported from vscode-git-graph)
  // ============================================================

  private determinePath(startAt: number): void {
    let i = startAt;
    let vertex = this.vertices[i];
    let parentVertex = vertex.getNextParent();
    let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint();

    if (
      parentVertex !== null &&
      parentVertex.id !== NULL_VERTEX_ID &&
      vertex.isMerge() &&
      !vertex.isNotOnBranch() &&
      !parentVertex.isNotOnBranch()
    ) {
      // Merge between two vertices already on branches
      let foundPointToParent = false;
      const parentBranch = parentVertex.getBranch()!;

      for (i = startAt + 1; i < this.vertices.length; i++) {
        const curVertex = this.vertices[i];
        let curPoint = curVertex.getPointConnectingTo(parentVertex, parentBranch);

        if (curPoint !== null) {
          foundPointToParent = true;
        } else {
          curPoint = curVertex.getNextPoint();
        }

        parentBranch.addLine(
          lastPoint,
          curPoint,
          !foundPointToParent && curVertex !== parentVertex
            ? lastPoint.x < curPoint.x
            : true
        );
        curVertex.registerUnavailablePoint(curPoint.x, parentVertex, parentBranch);
        lastPoint = curPoint;

        if (foundPointToParent) {
          vertex.registerParentProcessed();
          break;
        }
      }
    } else {
      // Normal branch
      const branch = new Branch(this.getAvailableColour(startAt));
      vertex.addToBranch(branch, lastPoint.x);
      vertex.registerUnavailablePoint(lastPoint.x, vertex, branch);

      for (i = startAt + 1; i < this.vertices.length; i++) {
        const curVertex = this.vertices[i];
        const curPoint =
          parentVertex === curVertex && !parentVertex!.isNotOnBranch()
            ? curVertex.getPoint()
            : curVertex.getNextPoint();

        branch.addLine(lastPoint, curPoint, lastPoint.x < curPoint.x);
        curVertex.registerUnavailablePoint(curPoint.x, parentVertex, branch);
        lastPoint = curPoint;

        if (parentVertex === curVertex) {
          vertex.registerParentProcessed();
          const parentVertexOnBranch = !parentVertex!.isNotOnBranch();
          parentVertex!.addToBranch(branch, curPoint.x);
          vertex = parentVertex!;
          parentVertex = vertex.getNextParent();
          if (parentVertex === null || parentVertexOnBranch) break;
        }
      }

      if (i === this.vertices.length && parentVertex !== null && parentVertex.id === NULL_VERTEX_ID) {
        vertex.registerParentProcessed();
      }

      branch.setEnd(i);
      this.branches.push(branch);
      this.availableColours[branch.getColour()] = i;
    }
  }

  private getAvailableColour(startAt: number): number {
    for (let i = 0; i < this.availableColours.length; i++) {
      if (startAt > this.availableColours[i]) {
        return i;
      }
    }
    this.availableColours.push(0);
    return this.availableColours.length - 1;
  }
}
