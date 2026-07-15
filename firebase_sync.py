import os
import json
from datetime import datetime
import firebase_admin
from firebase_admin import credentials, storage
import database

# Paths
DB_FILE = database.DB_FILE
LOCAL_LAST_MODIFIED_FILE = DB_FILE + ".sync"

firebase_app = None

def init_firebase():
    global firebase_app
    if firebase_app is not None:
        return firebase_app
        
    cred_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if not cred_json:
        # Check if local credentials file exists for dev environment
        if os.path.exists("firebase-key.json"):
            try:
                cred = credentials.Certificate("firebase-key.json")
            except Exception as e:
                print(f"Error loading local firebase-key.json: {e}")
                return None
        else:
            return None
    else:
        try:
            cred_dict = json.loads(cred_json)
            cred = credentials.Certificate(cred_dict)
        except Exception as e:
            print(f"Error parsing FIREBASE_SERVICE_ACCOUNT: {e}")
            return None
            
    try:
        firebase_app = firebase_admin.initialize_app(cred, {
            'storageBucket': 'gymos-eab08.firebasestorage.app'
        })
        return firebase_app
    except Exception as e:
        print(f"Error initializing Firebase Admin: {e}")
        return None

def get_remote_metadata():
    if not init_firebase():
        return None
    try:
        bucket = storage.bucket()
        blob = bucket.blob('database/gymos.db')
        if blob.exists():
            blob.reload()
            return blob.updated # datetime object (UTC)
    except Exception as e:
        print(f"Error getting remote metadata: {e}")
    return None

def sync_down():
    if not init_firebase():
        return
        
    try:
        bucket = storage.bucket()
        blob = bucket.blob('database/gymos.db')
        if not blob.exists():
            print("Remote database does not exist in Firebase Storage. Uploading local initial database.")
            sync_up()
            return
            
        blob.reload()
        remote_updated = blob.updated # datetime in UTC
        
        # Check local sync metadata
        local_updated = None
        if os.path.exists(LOCAL_LAST_MODIFIED_FILE):
            try:
                with open(LOCAL_LAST_MODIFIED_FILE, "r") as f:
                    local_updated_str = f.read().strip()
                    local_updated = datetime.fromisoformat(local_updated_str)
            except Exception:
                pass
                
        # If remote is newer, or local file doesn't exist, download it
        if not os.path.exists(DB_FILE) or not local_updated or remote_updated.timestamp() > local_updated.timestamp():
            print(f"Syncing down database: remote is newer ({remote_updated}) than local ({local_updated})")
            blob.download_to_filename(DB_FILE)
            # Save the remote update time locally
            with open(LOCAL_LAST_MODIFIED_FILE, "w") as f:
                f.write(remote_updated.isoformat())
    except Exception as e:
        print(f"Error during sync_down: {e}")

def sync_up():
    if not init_firebase():
        return
        
    try:
        if not os.path.exists(DB_FILE):
            print("Local database file does not exist, cannot sync up.")
            return
            
        print("Syncing up database to Firebase Storage...")
        bucket = storage.bucket()
        blob = bucket.blob('database/gymos.db')
        blob.upload_from_filename(DB_FILE)
        
        # Reload to get the new remote updated timestamp
        blob.reload()
        remote_updated = blob.updated
        with open(LOCAL_LAST_MODIFIED_FILE, "w") as f:
            f.write(remote_updated.isoformat())
        print("Database sync up completed successfully.")
    except Exception as e:
        print(f"Error during sync_up: {e}")
