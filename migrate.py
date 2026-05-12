import sqlite3

def migrate():
    try:
        conn = sqlite3.connect('ai_therapy.db')
        c = conn.cursor()
        try:
            c.execute("ALTER TABLE therapist_profiles ADD COLUMN degree VARCHAR")
        except Exception as e:
            print("degree column might already exist:", e)
        try:
            c.execute("ALTER TABLE therapist_profiles ADD COLUMN license_type VARCHAR")
        except Exception as e:
            print("license_type column might already exist:", e)
        try:
            c.execute("ALTER TABLE therapist_profiles ADD COLUMN license_number VARCHAR")
        except Exception as e:
            print("license_number column might already exist:", e)
            
        conn.commit()
        print("Migration successful")
    except Exception as e:
        print("Migration error:", e)
    finally:
        conn.close()

if __name__ == '__main__':
    migrate()
