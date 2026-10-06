% Cells, structs and function handles.
c = {1, 'two'; [1 2 3], {4}}
s.name = 'Ada';
s.age = 36;
s.scores = [90 85];
s
t = struct('a', {1, 2})
f = @(x) x.^2 + 1
g = @sin
e = struct()
