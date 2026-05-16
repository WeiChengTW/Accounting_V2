import sqlite3

conn = sqlite3.connect('bookkeeping.db')
c = conn.cursor()
c.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = c.fetchall()
print('Tables:', tables)
for t in tables:
    table_name = t[0]
    print(f'\nTable: {table_name}')
    c.execute(f'PRAGMA table_info({table_name})')
    for row in c.fetchall():
        print(row)
conn.close()
