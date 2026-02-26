// @ts-ignore don't install the @types for this package, as it conflicts with mongoose
import passportLocalMongoose from '@hyperdx/passport-local-mongoose';
import mongoose, { Schema } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

type ObjectId = mongoose.Types.ObjectId;

export type UserRole = 'admin' | 'member' | 'viewer';

export interface IUser {
  _id: ObjectId;
  accessKey: string;
  createdAt: Date;
  email: string;
  name: string;
  team: ObjectId;
  role: UserRole;
  // OIDC fields – set when user authenticates via external IdP
  oidcSubject?: string; // unique subject identifier from the IdP
  oidcIssuer?: string; // issuer URL (e.g. Keycloak realm URL)
}

export type UserDocument = mongoose.HydratedDocument<IUser>;

const UserSchema = new Schema(
  {
    name: String,
    email: {
      type: String,
      required: true,
    },
    team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
    accessKey: {
      type: String,
      default: function genUUID() {
        return uuidv4();
      },
    },
    role: {
      type: String,
      enum: ['admin', 'member', 'viewer'],
      default: 'admin', // first user / password-registered user defaults to admin
    },
    oidcSubject: { type: String, index: true },
    oidcIssuer: String,
  },
  {
    timestamps: true,
  },
);

UserSchema.virtual('hasPasswordAuth').get(function (this: IUser) {
  return true;
});

UserSchema.plugin(passportLocalMongoose, {
  usernameField: 'email',
  usernameLowerCase: true,
  usernameCaseInsensitive: true,
});

UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index(
  { oidcSubject: 1, oidcIssuer: 1 },
  { unique: true, sparse: true },
);

export default mongoose.model<IUser>('User', UserSchema);
