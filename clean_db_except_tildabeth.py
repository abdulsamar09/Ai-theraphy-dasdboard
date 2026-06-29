import sqlite3
import os

def main():
    db_path = "ai_therapy.db"
    if not os.path.exists(db_path):
        print(f"Database file {db_path} does not exist!")
        return
        
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    try:
        # Find the user id for tildabeth11@gmail.com
        cursor.execute("SELECT id, email, full_name FROM users WHERE LOWER(email) = 'tildabeth11@gmail.com'")
        row = cursor.fetchone()
        if not row:
            print("User tildabeth11@gmail.com not found in database!")
            return
        
        tildabeth_id, email, name = row
        print(f"Found user: {name} ({email}) with ID: {tildabeth_id}")
        
        # Delete from therapist_profiles
        cursor.execute("DELETE FROM therapist_profiles WHERE user_id != ?", (tildabeth_id,))
        print(f"Deleted from therapist_profiles: {cursor.rowcount} rows")
        
        # Delete from wallets
        cursor.execute("DELETE FROM wallets WHERE user_id != ?", (tildabeth_id,))
        print(f"Deleted from wallets: {cursor.rowcount} rows")
        
        # Delete from session_logs
        cursor.execute("DELETE FROM session_logs WHERE user_id != ?", (tildabeth_id,))
        print(f"Deleted from session_logs: {cursor.rowcount} rows")
        
        # Delete from refresh_tokens
        cursor.execute("DELETE FROM refresh_tokens WHERE user_id != ?", (tildabeth_id,))
        print(f"Deleted from refresh_tokens: {cursor.rowcount} rows")
        
        # Delete from users
        cursor.execute("DELETE FROM users WHERE id != ?", (tildabeth_id,))
        print(f"Deleted from users: {cursor.rowcount} rows")
        
        conn.commit()
        print("Database cleanup completed successfully.")
        
    except Exception as e:
        conn.rollback()
        print(f"Error during database cleanup: {e}")
    finally:
        conn.close()

if __name__ == "__main__":
    main()
