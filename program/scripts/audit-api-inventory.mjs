import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

// An entry-point index, not an authorization or correctness verifier.
const root=fileURLToPath(new URL('..',import.meta.url));
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):entry.isFile()&&entry.name==='route.ts'?[path.join(dir,entry.name)]:[]);
const methods=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']),writers=new Set(['POST','PUT','PATCH','DELETE']);
const rows=walk(path.join(root,'app/api')).sort().map(file=>{
  const bytes=readFileSync(file),source=ts.createSourceFile(file,bytes.toString('utf8'),ts.ScriptTarget.Latest,true),exports=[];
  for(const statement of source.statements) {
    if(!statement.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.ExportKeyword))continue;
    if(ts.isFunctionDeclaration(statement)&&statement.name&&methods.has(statement.name.text))exports.push(statement.name.text);
    if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)if(ts.isIdentifier(declaration.name)&&methods.has(declaration.name.text))exports.push(declaration.name.text);
  }
  const relative=path.relative(root,file).replaceAll('\\','/');
  return {file:relative,domain:relative.split('/')[2],methods:exports.sort(),writeMethods:exports.filter(method=>writers.has(method)).sort(),sha256:createHash('sha256').update(bytes).digest('hex'),reviewStatus:'indexed only'};
});
assert.ok(rows.length);assert.ok(rows.every(row=>row.methods.length));
const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(git.status,0);
const domains=Object.entries(Object.groupBy(rows,row=>row.domain)).map(([domain,entries])=>({domain,routeFiles:entries.length,filesWithWriteMethods:entries.filter(row=>row.writeMethods.length).length}));
const report={baseline:git.stdout.trim(),createdAt:new Date().toISOString(),routeFiles:rows.length,filesWithWriteMethods:rows.filter(row=>row.writeMethods.length).length,domains,rows,boundary:'Source AST exports and hashes only. GET may have side effects; write methods may delegate to libraries. Indexed is not reviewed, protected or validated. Runtime/permissions/data/real business acceptance require separate evidence.'};
const directory=path.join(root,'.local/project-audit-20261011');mkdirSync(directory,{recursive:true});writeFileSync(path.join(directory,'api-inventory-20261014.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({baseline:report.baseline,routeFiles:report.routeFiles,filesWithWriteMethods:report.filesWithWriteMethods,domains},null,2));
