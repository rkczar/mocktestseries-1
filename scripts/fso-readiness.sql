-- FSO launch readiness: READ-ONLY. Every row is one activation gate; status PASS / OPEN / FAIL.
-- Run: sudo -u postgres psql -d mocktestseries -At -F' | ' < scripts/fso-readiness.sql
-- OPEN = waits on an owner decision or approved action; FAIL = something is wrong now.
begin transaction read only;
with fso as (select * from "Exam" where code = 'RUHS-FSO'),
ruhs as (select * from "Exam" where code = 'RUHSMO'),
prod as (select * from "Product" where code = 'rpsc-fso-full-access'),
feat as (select value from "Setting" where key = 'exam.features.' || (select id from fso)),
pdfidx as (select value from "Setting" where key = 'exam.paperPdfs.' || (select id from fso)),
papers as (select p.year, p."isActive", (select count(*) from "Question" q where q."previousYearPaperId" = p.id and q.status = 'PUBLISHED') n
           from "PreviousYearPaper" p where p."examId" = (select id from fso)),
res as (select r.* from "TestResource" r where r."examId" = (select id from fso))
select * from (values
 -- Safety invariants (must stay PASS until activation)
 ('S1 RUHS MO active + public', case when (select "isActive" and "publicPageEnabled" from ruhs) then 'PASS' else 'FAIL' end, ''),
 ('S2 RUHS OMR switch ON', case when (select (value->>'omrDownloadEnabled')::bool from "Setting" where key = 'exam.features.' || (select id from ruhs)) then 'PASS' else 'FAIL' end, ''),
 ('S3 FSO hidden (isActive/publicPage false)', case when (select not "isActive" and not "publicPageEnabled" from fso) then 'PASS' else 'FAIL' end, 'flip only at G8'),
 ('S4 FSO product hidden + purchase off', case when (select not "isVisible" and not "purchaseEnabled" from prod) then 'PASS' else 'FAIL' end, 'flip only at G8'),
 -- Configuration
 ('C1 negative marking 1/3', case when (select abs("negativeMarking" - 1.0/3) < 0.001 from fso) then 'PASS' else 'FAIL' end, (select "negativeMarking"::text from fso)),
 ('C2 Exam.year (U6)', 'OPEN', 'DB year=' || coalesce((select year::text from fso), 'null') || '; no 2026 RPSC cycle announced'),
 ('C3 product ₹200, coupons off', case when (select "sellingPricePaise" = 20000 and "mrpPaise" = 20000 and not "couponsAllowed" and not "saleEnabled" from prod) then 'PASS' else 'FAIL' end, ''),
 ('C4 product access end date (D11)', case when (select "accessExpiresAt" is not null from prod) then 'PASS' else 'OPEN' end, coalesce((select "accessExpiresAt"::text from prod), 'not set: purchase refused until set')),
 -- Content
 ('Q1 PYQ 2019 active, 150 published', case when exists (select 1 from papers where year = 2019 and "isActive" and n = 150) then 'PASS' else 'FAIL' end, (select string_agg(year || ':' || n, ' ') from papers)),
 ('Q2 PYQ 2022 active, 150 published (Q92 own record)', case when exists (select 1 from papers where year = 2022 and "isActive" and n = 150) then 'PASS' else 'FAIL' end, ''),
 ('Q3 2019 Q145/Q148 defect assets removed', case when exists (select 1 from "QuestionAsset" where id in ('cmwcl40vj01l4kwkzihm7sgf8', 'cmwcl40w801likwkzlcg2w7q2')) then 'OPEN' else 'PASS' end, 'correction proposal fso-2019-corrections awaits owner'),
 ('Q4 FSO mock tests published', case when (select count(*) from "MockTest" where "examId" = (select id from fso) and status = 'PUBLISHED') > 0 then 'PASS' else 'OPEN' end, (select count(*) from "MockTest" where "examId" = (select id from fso))::text || ' FSO mocks (needs content decision)'),
 -- Downloads
 ('D1 OMR switch', case when (select (value->>'omrDownloadEnabled')::bool from feat) then 'PASS' else 'OPEN' end, 'OFF by design until G6'),
 ('D2 exactly one active FSO OMR sheet', case when (select count(*) from res where type = 'OMR_TEMPLATE' and "isActive") = 1 then 'PASS' else 'OPEN' end, (select count(*) from res where type = 'OMR_TEMPLATE')::text || ' sheets, ' || (select count(*) from res where type = 'OMR_TEMPLATE' and "isActive") || ' active'),
 ('D3 2022 PDFs indexed (3 langs)', case when (select count(*) from jsonb_array_elements((select value from pdfidx)->'entries') e where (e->>'year')::int = 2022) = 3 then 'PASS' else 'FAIL' end, ''),
 ('D4 2019 PDFs indexed (3 langs)', case when (select count(*) from jsonb_array_elements(coalesce((select value from pdfidx)->'entries', '[]')) e where (e->>'year')::int = 2019) = 3 then 'PASS' else 'OPEN' end, 'blocked by Q3'),
 ('D5 indexed PDFs active', case when (select bool_and(r."isActive") from res r where r.id in (select e->>'resourceId' from jsonb_array_elements(coalesce((select value from pdfidx)->'entries', '[]')) e)) then 'PASS' else 'OPEN' end, 'activate after owner PDF review (G6)'),
 ('D6 PDF switch', case when (select (value->>'paperDownloadEnabled')::bool from feat) then 'PASS' else 'OPEN' end, 'OFF by design until G6'),
 ('D7 no orphan PDF/OMR rows', case when (select count(*) from res where type = 'PAPER_PDF' and id not in (select e->>'resourceId' from jsonb_array_elements(coalesce((select value from pdfidx)->'entries', '[]')) e)) + greatest((select count(*) from res where type = 'OMR_TEMPLATE') - 1, 0) = 0 then 'PASS' else 'OPEN' end, 'cleanup needs owner approval'),
 -- People
 ('T1 teacher assigned to FSO', case when exists (select 1 from "TeacherExamAssignment" where "examId" = (select id from fso)) then 'PASS' else 'OPEN' end, 'optional')
) g(gate, status, detail);
rollback;
