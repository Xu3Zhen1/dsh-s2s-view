const {readFileSync}=require('fs');const {zstdDecompressSync}=require('zlib');
const dir='C:/Users/ZHAN_ZC/.dsh/sessions/--G-dsh-s2s-view--/24e3df51-af39-4ed1-a90c-d01887071192';
const {readdirSync}=require('fs');
console.log('files=',readdirSync(dir).join(','));
const f=dir+'/session.v4.jsonl.zstd';
const buf=readFileSync(f);
const starts=[];for(let i=0;i+4<=buf.length;i++){if(buf[i]===0x28&&buf[i+1]===0xb5&&buf[i+2]===0x2f&&buf[i+3]===0xfd)starts.push(i);}
let text='';for(let i=0;i<starts.length;i++){const a=starts[i],b=i+1<starts.length?starts[i+1]:buf.length;try{text+=zstdDecompressSync(buf.subarray(a,b)).toString('utf8');}catch{try{text+=zstdDecompressSync(buf.subarray(a)).toString('utf8');}catch{}break;}}
const lines=text.split('\n').filter(l=>l.trim());
console.log('total lines=',lines.length);
for(let i=0;i<Math.min(3,lines.length);i++){
  const o=JSON.parse(lines[i]);
  console.log('line',i,'type=',JSON.stringify(o.type),'| top-level keys=',Object.keys(o).join(','));
  if(o.origin!==undefined)console.log('  TOP origin=',JSON.stringify(o.origin));
  if(o.id!==undefined)console.log('  TOP id=',JSON.stringify(o.id));
  if(o.data&&o.data.origin!==undefined)console.log('  data.origin=',JSON.stringify(o.data.origin));
}
