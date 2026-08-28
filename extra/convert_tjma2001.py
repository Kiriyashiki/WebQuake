import csv
import os

input_file = "tjma2001"
output_file = "../public/tjma2001.csv"

with open(input_file, 'r') as f_in, open(output_file, 'w', newline='') as f_out:
    writer = csv.writer(f_out)
    writer.writerow(['depth', 'distance', 'p_time', 's_time'])
    
    for line in f_in:
        line = line.rstrip('\n\r')
        if not line:
            continue
        
        try:
            p_time = float(line[2:10].strip())
            s_time = float(line[13:21].strip())
            depth = int(line[22:25].strip())
            distance = int(line[27:32].strip())
            
            if depth % 10 == 0:
                writer.writerow([depth, distance, p_time, s_time])
        except ValueError as e:
            print(f"Error parsing line: '{line}' - {e}")

print("Conversion complete.")
