% Nested structs and struct arrays.
s.a = 1;
s.b = 'text';
s.c = [1 2 3];
s.d = {1, 'two'};
s.e.inner = 5;
s
t = struct('x', {1, 2})
t(2)
u = struct('m', magic(3))
v = struct('e', {})
w.f = @(x) x + 1;
w
