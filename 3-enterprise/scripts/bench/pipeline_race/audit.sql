-- Läuft parallel mit: hält jeden committeten Zustand fest, der eine Invariante verletzt
INSERT INTO violations (kind, owner_user_id)
SELECT 'inactive_with_pipeline', p.owner_user_id FROM pipelines p JOIN scim_users u ON u.id = p.owner_user_id
 WHERE NOT u.active AND p.status <> 'revoked'
UNION ALL
SELECT 'over_limit', owner_user_id FROM pipelines WHERE status <> 'revoked' GROUP BY owner_user_id HAVING count(*) > 3;
