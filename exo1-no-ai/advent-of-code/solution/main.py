from copy import deepcopy
# Loading file
f = open("./grid.txt")
content = f.readlines()
f.close()

# Setup
grid_dim = len(content), len(content[0])-1
grid = []
initial_pos = (-1,-1)
for i in range(grid_dim[0]):
    line_array = list(content[i].strip())
    if "^" in line_array:
        for j in range(len(line_array)):
            if line_array[j]=="^":
                initial_pos = (i,j)
    grid.append(line_array)

# Step 1

def next_pos_free(grid: list[list], current_pos: tuple[int,int], grid_dim: tuple[int,int], row_displacement: int, col_displacement: int)-> tuple[bool, bool]:
    new_pos = (current_pos[0]+row_displacement, current_pos[1]+col_displacement)
    # Terminal conditions
    if new_pos[0]>=grid_dim[0] or new_pos[0]<0 or new_pos[1]>=grid_dim[1] or new_pos[1]<0:
        return True, False # next case free, algorithm running
    # next case is blocked 
    elif grid[new_pos[0]][new_pos[1]] == "#":
        return False, True
    else:
        return True, True


def step_one(grid:list[list], max_number_of_step: None | int =None, step_one_res = False)-> bool:
    movement = {"^":(-1,0), "<": (0,-1), ">":(0,1), "v":(1,0)}
    rotation_90_degree = {"^":">", "<": "^", ">":"v", "v":"<"}
    running = False if initial_pos == (-1,-1) else True
    is_looping = False
    current_pos = initial_pos
    direction = "^"
    seen_pos = set()
    seen_pos.add((initial_pos,direction))
    while running:
        displacement = movement[direction]
        row_displacement, col_displacement = displacement
        is_next_pos_free, running = next_pos_free(grid = grid, current_pos = current_pos, grid_dim=grid_dim, 
                                    row_displacement= row_displacement, col_displacement=col_displacement)
        if is_next_pos_free:
            grid[current_pos[0]][current_pos[1]] = "X"
            current_pos = (current_pos[0]+displacement[0], current_pos[1]+displacement[1])
        else:
            direction = rotation_90_degree[direction]
        if (current_pos,direction) in seen_pos:
            is_looping=True
            running=False
        seen_pos.add((current_pos,direction))

    # print(number_of_step)
    # final count 
    if step_one_res:
        number_visited_pos = 0
        for line in grid:
            for char in line:
                if char =="X":
                    number_visited_pos+=1

        print(number_visited_pos) # 4819
    return is_looping, grid

def step_two():
    answer =0
    _, solved_grid = step_one(grid= deepcopy(grid))
    for i in range(grid_dim[0]):
        for j in range(grid_dim[1]):
            if solved_grid[i][j] == "#" or solved_grid[i][j] == ".":
                continue
            local_grid = deepcopy(grid)
            local_grid[i][j] = "#"
            looping, _ = step_one(grid= local_grid)
            if looping:
                answer +=1
    print(answer)

step_two()

        
