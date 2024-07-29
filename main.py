import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.patches as patches
import matplotlib.colors as mcolors
from datetime import datetime, timedelta
import numpy as np

# Read the CSV file
schedule = pd.read_csv('schedule.csv')

# Define a function to convert time to a numerical value
def time_to_num(time_str):
    time_obj = datetime.strptime(time_str, '%H:%M')
    return time_obj.hour + time_obj.minute / 60

# Define a function to split text into multiple lines, using better line splitting
def split_text(text, max_length):
    words = text.split()
    lines = []
    current_line = []
    current_length = 0
    for word in words:
        if current_length + len(word) + len(current_line) > max_length:
            lines.append(" ".join(current_line))
            current_line = [word]
            current_length = len(word)
        else:
            current_line.append(word)
            current_length += len(word)
    lines.append(" ".join(current_line))
    return "\n".join(lines)

# Generate a color for each unique activity using a large colormap
unique_activities = schedule['Activité'].unique()
# Create a large color palette by combining multiple colormaps
colors = np.concatenate([plt.get_cmap('tab20').colors,
                         plt.get_cmap('tab20b').colors,
                         plt.get_cmap('tab20c').colors])

activity_colors = {activity: colors[i % len(colors)] for i, activity in enumerate(unique_activities)}

# Get all unique times to create y-ticks
times = sorted(set(schedule['Heure de début'].tolist() + schedule['Heure de fin'].tolist()))
time_ticks = [time_to_num(t) for t in times]
time_labels = times

# Create a plot
fig, ax = plt.subplots(figsize=(12, 16))  # Increased height for better visibility

# Set the limits and labels for the plot
ax.set_xlim(0, 7)
ax.set_ylim(time_to_num('09:00'), time_to_num('23:59'))
ax.set_xticks(range(7))
ax.set_xticklabels(['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'])
ax.set_yticks(time_ticks)
ax.set_yticklabels(time_labels)

# Loop through the schedule and add rectangles to the plot
for _, row in schedule.iterrows():
    day = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'].index(row['Jour'])
    start_time = time_to_num(row['Heure de début'])
    end_time = time_to_num(row['Heure de fin'])
    activity = row['Activité']
    ax.add_patch(
        patches.Rectangle(
            (day, start_time),  # (x, y)
            1,  # width
            end_time - start_time,  # height
            edgecolor='black',
            facecolor=mcolors.to_rgba(activity_colors[activity], alpha=0.5),
            linewidth=1
        )
    )
    font_size = 8 if end_time - start_time >= 0.5 else 6
    wrapped_text = split_text(activity, 20)  # Use more of the width before wrapping
    ax.text(day + 0.5, (start_time + end_time) / 2, wrapped_text, ha='center', va='center', fontsize=font_size, wrap=True)

# Add grid lines
ax.grid(True, which='both', linestyle='--', linewidth=0.5)

# Invert the y-axis to have the time start from top
ax.invert_yaxis()

# Set labels
plt.title('Emploi du Temps')
plt.xlabel('Jour')
plt.ylabel('Heure')

# Save the plot as a PNG image
plt.tight_layout()
plt.savefig('emploi_du_temps12.png')
plt.close(fig)
