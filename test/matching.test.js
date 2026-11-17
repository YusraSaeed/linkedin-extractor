const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeProfile,matchProfile,indexRows,buildChanges}=require('../server');
const mapping=require('../field-mapping.json');
test('normalizes LinkedIn URL parameters and trailing slash',()=>{
 const a='https://www.linkedin.com/in/brenda-hebb-trenowden-cbe-a23202b/?originalSubdomain=uk';
 assert.equal(normalizeProfile(a),'brenda-hebb-trenowden-cbe-a23202b');
 assert.equal(normalizeProfile('https://linkedin.com/in/BRENDA-HEBB-TRENOWDEN-CBE-a23202b'),'brenda-hebb-trenowden-cbe-a23202b');
});
test('URL primary matches unique record',()=>{
 const index=indexRows([{Id:19,ProfileURL:'https://linkedin.com/in/laurie-evans-2096488a/?foo=1',FullName:'Laurie Evans'}]);
 const r=matchProfile({profileUrl:'https://www.linkedin.com/in/laurie-evans-2096488a/',fullName:'Laurie Evans'},index);
 assert.equal(r.row.Id,19);assert.equal(r.method,'ProfileURL');
});
test('duplicate URL goes to review',()=>{
 const r=matchProfile({profileUrl:'https://linkedin.com/in/x',fullName:'X'},indexRows([{Id:1,ProfileURL:'https://linkedin.com/in/x',FullName:'X'},{Id:2,ProfileURL:'https://linkedin.com/in/x/',FullName:'X'}]));
 assert.equal(r.status,'review');
});
test('name fallback only unique when no contradictory URL',()=>{
 const rows=[{Id:10,ProfileURL:'https://linkedin.com/in/x/',FullName:'Jane Doe'}];
 assert.equal(matchProfile({profileUrl:'https://linkedin.com/in/y/',fullName:'Jane Doe'},indexRows(rows)).status,'review');
 assert.equal(matchProfile({profileUrl:'',fullName:'Jane Doe'},indexRows(rows)).method,'FullName');
});
test('only allowed nonempty mapped properties; never identifiers',()=>{
 const out=buildChanges({'fullName':'Laurie Evans','about':'Test','school 1':'','contact':'x'},new Set([...Object.values(mapping),'ProfileURL','FullName']));
 assert.deepEqual(out,{'fullName 2':'Laurie Evans','about':'Test'});
 assert.ok(!('FullName' in out));assert.ok(!('ProfileURL' in out));
});
