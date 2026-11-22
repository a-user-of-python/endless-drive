'use strict';
/* DDS decoder: DXT1/BC1, DXT3, DXT5/BC3, uncompressed 32-bit. No deps. */
function decodeDDS(bytes){
  if(!bytes || bytes.length<128) throw new Error('DDS: file too short ('+(bytes?bytes.length:0)+' bytes)');
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if(!(b[0]===0x44&&b[1]===0x44&&b[2]===0x53&&b[3]===0x20)) throw new Error('DDS: bad magic, not a DDS file');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const height = dv.getUint32(12,true), width = dv.getUint32(16,true);
  const mipCount = dv.getUint32(28,true);
  const pfFlags = dv.getUint32(80,true);
  const fourCC = String.fromCharCode(b[84],b[85],b[86],b[87]);
  const rgbBits = dv.getUint32(88,true);
  const rMask = dv.getUint32(92,true), gMask = dv.getUint32(96,true), blMask = dv.getUint32(100,true), aMask = dv.getUint32(104,true);
  if(!width||!height) throw new Error('DDS: zero width/height');
  const data = new Uint8Array(width*height*4);
  const off = 128;
  function c565(v){ const r=((v>>11)&31)*255/31, g=((v>>5)&63)*255/63, bl=(v&31)*255/31; return [r,g,bl]; }
  function decodeColorBlock(src, dstX, dstY, alphaArr){
    const c0=dv.getUint16(src,true), c1=dv.getUint16(src+2,true), bits=dv.getUint32(src+4,true);
    const A=c565(c0), B=c565(c1); const pal=[A,B];
    if(c0>c1){ pal.push([(2*A[0]+B[0])/3,(2*A[1]+B[1])/3,(2*A[2]+B[2])/3,255]); pal.push([(A[0]+2*B[0])/3,(A[1]+2*B[1])/3,(A[2]+2*B[2])/3,255]); }
    else { pal.push([(A[0]+B[0])/2,(A[1]+B[1])/2,(A[2]+B[2])/2,255]); pal.push([0,0,0,0]); }
    for(let i=0;i<16;i++){
      const idx=(bits>>(i*2))&3, px=dstX+(i%4), py=dstY+((i/4)|0);
      if(px>=width||py>=height) continue;
      const o=(py*width+px)*4, col=pal[idx];
      data[o]=col[0]; data[o+1]=col[1]; data[o+2]=col[2];
      data[o+3]= alphaArr ? alphaArr[i] : (col.length>3?col[3]:255);
    }
  }
  if(fourCC==='DXT1' || fourCC==='BC1 '){
    let src=off;
    for(let by=0;by<height;by+=4){ for(let bx=0;bx<width;bx+=4){ if(src+8>b.length) throw new Error('DDS: truncated DXT1 data'); decodeColorBlock(src,bx,by,null); src+=8; } }
  } else if(fourCC==='DXT3'){
    let src=off;
    for(let by=0;by<height;by+=4){ for(let bx=0;bx<width;bx+=4){ if(src+16>b.length) throw new Error('DDS: truncated DXT3 data');
      const alpha=[]; for(let i=0;i<16;i++){ const byte=b[src+((i/2)|0)]; const nib=(i%2===0)?(byte&15):(byte>>4); alpha.push(nib*17); }
      decodeColorBlock(src+8,bx,by,alpha); src+=16; } }
  } else if(fourCC==='DXT5' || fourCC==='BC3 '){
    let src=off;
    for(let by=0;by<height;by+=4){ for(let bx=0;bx<width;bx+=4){ if(src+16>b.length) throw new Error('DDS: truncated DXT5 data');
      const a0=b[src], a1=b[src+1]; const apal=[a0,a1];
      if(a0>a1){ for(let i=1;i<=6;i++) apal.push(((7-i)*a0+i*a1)/7); } else { for(let i=1;i<=4;i++) apal.push(((5-i)*a0+i*a1)/5); apal.push(0,255); }
      // 48-bit alpha index field
      let bitsLo = (b[src+2]|(b[src+3]<<8)|(b[src+4]<<16))>>>0, bitsHi=(b[src+5]|(b[src+6]<<8)|(b[src+7]<<16))>>>0;
      const alpha=[]; for(let i=0;i<16;i++){ let idx; if(i<8){ idx=(bitsLo>>(i*3))&7; } else { idx=(bitsHi>>((i-8)*3))&7; } alpha.push(apal[idx]); }
      decodeColorBlock(src+8,bx,by,alpha); src+=16; } }
  } else if(fourCC==='DX10' || fourCC==='BC7 ' || fourCC==='ATI1' || fourCC==='ATI2' || fourCC==='BC4 ' || fourCC==='BC5 ' || fourCC==='BC6H'){
    throw new Error('DDS: unsupported format "'+fourCC.trim()+'" (BC4/BC5/BC6/BC7/ATI are not decoded; reported as unsupported)');
  } else if((pfFlags & 0x40) && rgbBits===32){ // DDPF_RGB uncompressed
    function chan(px,mask){ if(!mask) return 0; let shift=0; while(((mask>>>shift)&1)===0) shift++; let bits=0,m=mask; while(m){ bits+=m&1; m>>>=1; } const max=(1<<bits)-1; return ((px&mask)>>>shift)*255/max; }
    for(let i=0;i<width*height;i++){ const src=off+i*4; if(src+4>b.length) break; const px=dv.getUint32(src,true); const o=i*4;
      data[o]=chan(px,rMask); data[o+1]=chan(px,gMask); data[o+2]=chan(px,blMask); data[o+3]= aMask?chan(px,aMask):255; }
  } else {
    throw new Error('DDS: unsupported format FourCC="'+fourCC+'" flags=0x'+pfFlags.toString(16)+' bits='+rgbBits);
  }
  return { width:width, height:height, data:data, mipCount:mipCount, format:fourCC.trim()||'RGB32' };
}
const API = { decodeDDS:decodeDDS };
if (typeof globalThis!=='undefined') globalThis.__DDS = API;
if (typeof module!=='undefined') module.exports = API;
