const mongoose = require('mongoose');
const { Schema } = mongoose;

const counterSchema = new Schema({
  _id: { type: String, required: true },
  seq: { type: Number, required: true, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Counter', counterSchema);
