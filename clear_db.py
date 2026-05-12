from database import SessionLocal, engine, Base
from models import User, TherapistProfile, Wallet, SessionLog, RefreshToken

def clear_all():
    db = SessionLocal()
    try:
        print("Clearing all tables...")
        db.query(RefreshToken).delete()
        db.query(SessionLog).delete()
        db.query(Wallet).delete()
        db.query(TherapistProfile).delete()
        db.query(User).delete()
        db.commit()
        print("Done. All users and data cleared.")
    except Exception as e:
        print(f"Error: {e}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    clear_all()
