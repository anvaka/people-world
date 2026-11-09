// Works out the sea of a world (kinpeki-sea.js) off the main thread, with the vertices the GPU
// draws its waves from: first everything but the finest waves (the page waits for that), then the
// finest waves, which only close views show
import {buildSea, lineVertices} from './kinpeki-sea.js';
self.onmessage = ({data}) => {
  try {
    let sea = buildSea(data);
    let refine = sea.refine;
    delete sea.refine;
    sea.vertices = lineVertices(sea.strokes, sea.grid, sea.domain);
    let grid = {...sea.grid, near: sea.grid.near.slice()};   // (kept here: the original is handed over)
    // (the strokes are copied, not handed over: the finest level is traced among them next)
    let transfer = [sea.grid.near.buffer, sea.grid.mottle.buffer, sea.vertices.v.buffer];
    self.postMessage({id: data.id, sea}, transfer);
    let fine = refine();
    let fineVertices = lineVertices(fine, grid, sea.domain);
    self.postMessage({id: data.id, fine, fineVertices}, [fineVertices.v.buffer, ...fine.map(s => s.xy.buffer)]);
  } catch (e) {
    self.postMessage({id: data.id, error: e.message});
  }
};
