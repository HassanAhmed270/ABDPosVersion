const mongoose = require('mongoose');
const { Schema } = mongoose;


const auditLogSchema = new Schema({

  action: { type: String, required: true },
  actor: {
    username: { type: String, required: true },
    role: { type: String, required: true },
  },

  targetType: { type: String, required: true },
  targetId: { type: String, required: true },

  before: { type: Schema.Types.Mixed, default: null },
  after: { type: Schema.Types.Mixed, default: null },
  date: { type: Date, default: Date.now },
});

auditLogSchema.index({ date: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
