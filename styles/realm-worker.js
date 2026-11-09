// The realm style's worker: prepares a world's fields, rivers and triangles off the page's thread
import {prepareWorld} from './realm-prep.js';

self.onmessage = ({data}) => {
  try {
    let out = prepareWorld(data.world);
    self.postMessage({job: data.job, out}, [out.fields.f1.buffer, out.fields.f2.buffer, out.rivers.buffer, out.tris.buffer]);
  } catch (error) {
    self.postMessage({job: data.job, error: error.message});
  }
};
