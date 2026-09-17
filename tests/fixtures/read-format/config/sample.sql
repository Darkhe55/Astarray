-- 行注释
/* 块注释 */
SELECT 'it''s -- not a comment' AS text_value,
       "quoted -- identifier" AS "col//name"
FROM example_table -- 尾随注释
WHERE url = 'https://example.com/a//b';
