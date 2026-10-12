import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import {zipSync,strToU8,unzipSync,strFromU8} from 'fflate';

const root=fileURLToPath(new URL('..',import.meta.url)),fixture=path.join(root,'.local/xlsx-browser',Date.now().toString());await mkdir(fixture,{recursive:true});
await writeFile(path.join(fixture,'index.html'),'<html><meta charset="utf-8"><script type="module" src="/entry.ts"></script><p>Isolated XLSX parser checks</p></html>');
await writeFile(path.join(fixture,'entry.ts'),'import {readFirstWorksheet} from "../../../lib/xlsx-table";import {validateKnowledgeImportRows} from "../../../lib/knowledge-import";window.readWorkbook=readFirstWorksheet;window.validateKnowledge=validateKnowledgeImportRows;');
const {chromium}=await import(pathToFileURL(process.env.LAN_TEST_PLAYWRIGHT_MODULE||path.join(root,'.local/ecommerce-browser/node_modules/playwright/index.mjs')).href);
const server=await createServer({configFile:false,root:fixture,server:{host:'127.0.0.1',port:0,fs:{allow:[root]}}}),checks=[];let browser,page;
const namespace='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const inline=(r,text)=>`<c r="${r}" t="inlineStr"><is><t>${text}</t></is></c>`;
const row=(r,content)=>`<row r="${r}">${content}</row>`;
const basic=row(1,inline('A1','标题')+inline('B1','数值'))+row(2,inline('A2',' 合成正文 ')+`<c r="B2"><v>42</v></c>`);
function pack(content=basic,{shared,relationship,target='worksheets/sheet1.xml',extra={},prefix=false,workbook}={}){
 let sheet=`<worksheet xmlns="${namespace}"><sheetData>${content}</sheetData></worksheet>`;
 if(prefix)sheet=sheet.replace(/<(\/?)(worksheet|sheetData|row|c|is|t|v)(?=[\s>])/g,'<$1:s:$2').replaceAll('<:','<').replaceAll('</:','</').replace('xmlns=', 'xmlns:s=');
 return zipSync({'xl/workbook.xml':strToU8(workbook??`<workbook xmlns="${namespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="First" sheetId="1" r:id="first"/></sheets></workbook>`),'xl/_rels/workbook.xml.rels':strToU8(relationship??`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="first" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/></Relationships>`),'xl/worksheets/sheet1.xml':strToU8(sheet),...(shared?{'xl/sharedStrings.xml':strToU8(shared)}:{}),...extra});
}
function resized(bytes,name,size){const copy=bytes.slice(),v=new DataView(copy.buffer);for(let i=0;i<copy.length-46;i++){const sig=v.getUint32(i,true);if(![0x02014b50,0x04034b50].includes(sig))continue;const n=v.getUint16(i+(sig===0x02014b50?28:26),true),offset=sig===0x02014b50?46:30;if(new TextDecoder().decode(copy.subarray(i+offset,i+offset+n))===name)v.setUint32(i+(sig===0x02014b50?24:22),size,true);}return copy;}
async function read(bytes,options){return page.evaluate(async({bytes,options})=>{try{return{rows:await window.readWorkbook(new File([new Uint8Array(bytes)],'synthetic.xlsx'),options)}}catch(error){return{error:error.message}}},{bytes:Array.from(bytes),options});}
async function check(name,run){try{await run();checks.push({name,passed:true});console.log(`PASS ${name}`);}catch(error){checks.push({name,passed:false,error:error.message});process.exitCode=1;console.error(`FAIL ${name}: ${error.message}`);}}
async function refuses(name,bytes,message,options){await check(name,async()=>{const result=await read(bytes,options);assert.match(result.error??'',message);assert.equal(result.rows,undefined);});}
try{
 await server.listen();browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>Boolean(window.readWorkbook));
 await check('native-DOMParser-basic-binary-ZIP-and-original-text',async()=>{assert.deepEqual((await read(pack())).rows,[{'标题':' 合成正文 ','数值':42}]);});
 await refuses('selected-XML-declared-size-budget-before-inflate',resized(pack(),'xl/worksheets/sheet1.xml',16*1024*1024+1),/展开大小超限/);
 await refuses('forged-small-XML-output-never-truncates',resized(pack(),'xl/worksheets/sheet1.xml',10),/实际展开量超过/);
 await check('unneeded-large-content-is-skipped',async()=>{const bytes=resized(pack(basic,{extra:{'xl/media/unused.bin':new Uint8Array(1)}}),'xl/media/unused.bin',32*1024*1024);assert.equal((await read(bytes)).rows.length,1);});
 await check('prefixed-worksheet-namespaces-read-correctly',async()=>{const bytes=pack(basic,{prefix:true});assert.deepEqual((await read(bytes)).rows,[{'标题':' 合成正文 ','数值':42}]);});
 await check('shared-rich-text-excludes-phonetic-annotation',async()=>{const shared=`<sst xmlns="${namespace}"><si><r><t>原</t></r><r><t>文</t></r><rPh><t>拼音</t></rPh></si></sst>`;const value=row(1,inline('A1','标题'))+row(2,'<c r="A2" t="s"><v>0</v></c>');assert.deepEqual((await read(pack(value,{shared}))).rows,[{'标题':'原文'}]);});
 await refuses('missing-shared-index-is-not-blank',pack(row(1,inline('A1','标题')+inline('B1','数值'))+row(2,inline('A2','value')+'<c r="B2" t="s"><v>5</v></c>')),/共享文本索引无效/);
 await refuses('duplicate-header-cannot-overwrite-a-column',pack(row(1,inline('A1','标题')+inline('B1','标题'))+row(2,inline('A2','first')+inline('B2','second'))),/表头.*重复/);
 await refuses('unheaded-populated-column-is-not-dropped',pack(row(1,inline('A1','标题'))+row(2,inline('A2','first')+inline('B2','second'))),/没有对应表头/);
 await refuses('duplicate-cell-coordinate-is-not-overwritten',pack(row(1,inline('A1','标题'))+row(2,inline('A2','first')+inline('A2','second'))),/坐标重复/);
 await refuses('out-of-range-coordinate-fails-clearly',pack(row(1,inline('A1','标题'))+row(2,inline('XFE2','far'))),/超出工作表范围/);
 await refuses('missing-relationship-does-not-fall-back-to-another-sheet',pack(basic,{relationship:'<Relationships/>'}),/关联缺失/);
 await refuses('external-relationship-is-not-followed',pack(basic,{relationship:'<Relationships><Relationship Id="first" Target="https://example.invalid/sheet.xml" TargetMode="External"/></Relationships>'}),/指向外部/);
 await refuses('XML-entity-declarations-are-not-expanded',pack(basic,{workbook:'<!DOCTYPE workbook [<!ENTITY test "synthetic">]><workbook/>'}),/实体声明/);
 await refuses('formula-without-cache-does-not-become-empty',pack(row(1,inline('A1','标题'))+row(2,'<c r="A2"><f>1+1</f></c>')),/公式没有保存计算结果/);
 await check('cached-string-formula-preserves-leading-zero',async()=>{assert.deepEqual((await read(pack(row(1,inline('A1','编号'))+row(2,'<c r="A2" t="str"><f>TEXT(123,"00000")</f><v>00123</v></c>')))).rows,[{'编号':'00123'}]);});
 await refuses('Excel-error-cell-is-not-a-business-value',pack(row(1,inline('A1','标题'))+row(2,'<c r="A2" t="e"><v>#DIV/0!</v></c>')),/错误单元格/);
 await check('blank-formatting-and-whitespace-preserve-values',async()=>{const value=row(1,inline('A1','标题')+inline('C1','备注'))+row(2,inline('A2','value')+inline('C2','   '))+row(1048576,'<c r="XFD1048576"/>');assert.deepEqual((await read(pack(value))).rows,[{'标题':'value','备注':'   '}]);});
 await check('CDATA-text-with-angle-brackets-is-not-counted-as-structure',async()=>{const value=row(1,inline('A1','标题'))+row(2,'<c r="A2" t="inlineStr"><is><t><![CDATA['+'<'.repeat(20000)+']]></t></is></c>');assert.equal((await read(pack(value))).rows[0]['标题'].length,20000);});
 await check('literal-DOCTYPE-text-inside-CDATA-is-preserved',async()=>{const value=row(1,inline('A1','标题'))+row(2,'<c r="A2" t="inlineStr"><is><t><![CDATA[<!DOCTYPE html> 示例文字]]></t></is></c>');assert.equal((await read(pack(value))).rows[0]['标题'],'<!DOCTYPE html> 示例文字');});
 for(const [maximum,extra]of [[100,0],[500,0],[100,1],[500,1]]){const value=row(1,inline('A1','标题'))+Array.from({length:maximum+extra},(_,i)=>row(i+2,inline('A'+(i+2),'value'+i))).join('');if(extra)await refuses(`row-limit-${maximum}-refuses-without-truncation`,pack(value),new RegExp(`最多导入 ${maximum} 行`),{maximumRows:maximum});else await check(`row-limit-${maximum}-exact-boundary`,async()=>{assert.equal((await read(pack(value),{maximumRows:maximum})).rows.length,maximum);});}
 await check('large-file-refused-before-reading',async()=>{const result=await page.evaluate(async()=>{let called=false;try{await window.readWorkbook({size:20*1024*1024+1,arrayBuffer(){called=true;throw Error('must not read');}})}catch(error){return{error:error.message,called}}});assert.match(result.error,/20 MiB/);assert.equal(result.called,false);});
 const columnName=index=>{let name='';for(let n=index+1;n>0;n=Math.floor((n-1)/26))name=String.fromCharCode(65+(n-1)%26)+name;return name;};
 await check('256-column-boundary-preserves-column-positions',async()=>{const value=row(1,Array.from({length:256},(_,i)=>inline(columnName(i)+'1','field'+i)).join(''))+row(2,inline('IV2','edge'));const result=await read(pack(value));assert.equal(Object.keys(result.rows[0]).length,256);assert.equal(result.rows[0].field255,'edge');assert.equal(result.rows[0].field0,'');});
 await refuses('257-column-table-refuses-before-returning-rows',pack(row(1,Array.from({length:257},(_,i)=>inline(columnName(i)+'1','field'+i)).join(''))+row(2,inline('A2','value'))),/最多 256 列/);
 await check('cell-text-exact-32767-boundary-is-preserved',async()=>{const value=row(1,inline('A1','标题'))+row(2,inline('A2','x'.repeat(32767)));assert.equal((await read(pack(value))).rows[0]['标题'].length,32767);});
 await refuses('cell-text-above-32767-refuses-without-clipping',pack(row(1,inline('A1','标题'))+row(2,inline('A2','x'.repeat(32768)))),/文本过长/);
 await refuses('excess-XML-structure-refuses-before-DOM-building',pack(basic,{extra:{'xl/worksheets/sheet1.xml':strToU8('<worksheet><cols>'+'<col/>'.repeat(100001)+'</cols><sheetData>'+basic+'</sheetData></worksheet>')}}),/结构过多/);
 await refuses('excess-empty-formatted-rows-refuses-clearly',pack(basic+Array.from({length:9999},(_,i)=>row(i+3,'')).join('')),/格式行过多/);
 await check('blank-shipped-brand-template-explains-no-data',async()=>{const bytes=await readFile(path.join(root,'public/templates/品牌知识库导入模板.xlsx')),result=await read(bytes,{maximumBytes:5*1024*1024,maximumRows:100});assert.match(result.error,/没有可导入的数据行/);});
 await check('filled-shipped-brand-template-reads-and-validates',async()=>{
   const files=unzipSync(await readFile(path.join(root,'public/templates/品牌知识库导入模板.xlsx')));let xml=strFromU8(files['xl/worksheets/sheet1.xml']);
   for(const [column,value]of [['A','合成品牌知识'],['B','其他'],['C','这是一条隔离模板验证用的合成品牌知识。'],['D','人工录入']])xml=xml.replace(new RegExp('<x:c r="'+column+'2"[^>]*/>'),match=>match.slice(0,-2)+'><x:v>'+value+'</x:v></x:c>');
   files['xl/worksheets/sheet1.xml']=strToU8(xml);const result=await read(zipSync(files),{maximumBytes:5*1024*1024,maximumRows:100});assert.equal(result.error,undefined,result.error);assert.equal(result.rows.length,1);
   const validation=await page.evaluate(rows=>window.validateKnowledge(rows),result.rows);assert.equal(validation.rows.length,1);assert.deepEqual(validation.issues,[]);
 });
 const dateData=value=>row(1,inline('A1','发布时间')+inline('B1','数值'))+row(2,`<c r="A2"><v>${value}</v></c><c r="B2"><v>7</v></c>`);
 const dateWorkbook=flag=>`<workbook xmlns="${namespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="${flag}"/><sheets><sheet r:id="first"/></sheets></workbook>`;
 await check('1900-numeric-publish-date-normalized-only-in-requested-column',async()=>{assert.deepEqual((await read(pack(dateData(46308)),{dateHeaders:['发布时间']})).rows,[{'发布时间':'2026-10-13T00:00:00.000Z','数值':7}]);});
 await check('1904-numeric-publish-date-uses-workbook-calendar',async()=>{for(const flag of ['1','true',' true '])assert.deepEqual((await read(pack(dateData(44846),{workbook:dateWorkbook(flag)}),{dateHeaders:['发布时间']})).rows,[{'发布时间':'2026-10-13T00:00:00.000Z','数值':7}]);});
 await check('1904-fractional-date-honors-explicit-offset',async()=>{assert.equal((await read(pack(dateData(44846.5),{workbook:dateWorkbook('1')}),{dateHeaders:['发布时间'],offsetMinutes:480})).rows[0]['发布时间'],'2026-10-13T04:00:00.000Z');});
 await check('1904-generic-knowledge-numbers-are-not-reinterpreted',async()=>{assert.equal((await read(pack(dateData(44846),{workbook:dateWorkbook('true')}))).rows[0]['发布时间'],44846);});
 await refuses('invalid-workbook-date-flag-refuses-ambiguous-calendar',pack(dateData(44846),{workbook:dateWorkbook('yes')}),/日期系统属性无效/,{dateHeaders:['发布时间']});
 await refuses('fake-excel-leap-day-refuses',pack(dateData(60)),/不存在的 1900-02-29/,{dateHeaders:['发布时间']});
 await refuses('duplicate-workbook-properties-refuse',pack(dateData(44846),{workbook:dateWorkbook('1').replace('<sheets>','<workbookPr date1904="0"/><sheets>')}),/日期属性重复/,{dateHeaders:['发布时间']});
 assert.deepEqual(errors,[]);
}catch(error){process.exitCode=1;console.error(error.stack);}finally{if(browser)await browser.close();await server.close();await writeFile(path.join(fixture,'report.json'),JSON.stringify({passed:!process.exitCode,checks,synthetic:true,boundary:'Actual Edge DOMParser/fflate and repository XLSX reader; synthetic archives and shipped template, no production UI, HTTP writes, real accounts or models'},null,2));console.log(`Evidence: ${fixture}`);}
