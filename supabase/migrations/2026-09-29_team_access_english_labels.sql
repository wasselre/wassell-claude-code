-- Team & Access: three rows still carried the placeholder English label they
-- were created with ("New Profile" / "New Role"), so the English UI showed the
-- placeholder instead of a name. Only rows still holding the placeholder are
-- touched, so an operator's later rename is never overwritten.
UPDATE public.profiles SET label_en = 'Marketing member'
 WHERE id = '615bb232-1d9e-4b22-84b8-13f1b7a07b57' AND label_en = 'New Profile';
UPDATE public.roles SET label_en = 'System administrator'
 WHERE id = 'c84e68ce-4c2a-48a6-b90c-a210f511f25a' AND label_en = 'New Role';
UPDATE public.roles SET label_en = 'Technical admin'
 WHERE id = '3a7428c6-9f58-401b-a23d-a9748d921803' AND label_en = 'New Role';
