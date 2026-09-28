/**
 * controllers/userController.js
 *
 * User management endpoints — /api/users (admin-only, see routes/api.js).
 * (Split out of the former monolithic controllers/apiController.js.)
 */

const logger = require('../helpers/logger');
const {
  createUser: createUserAccount,
  getUsers: getUserList,
  updateUserPassword,
  deleteUser,
} = require('../services/userService');

function getUsers(req, res) {
  res.json({ success: true, data: getUserList() });
}

function createUser(req, res) {
  const { username, password, role } = req.body || {};
  const result = createUserAccount(username, password, role);
  if (!result.success) {
    return res.status(400).json(result);
  }
  return res.json(result);
}

/**
 * PUT /api/users/:username/password
 * Update a user's password (admin only)
 */
function updateUserPasswordHandler(req, res) {
  try {
    const { username } = req.params;
    const { password } = req.body || {};

    if (!password || password.trim().length < 4) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 4 characters.'
      });
    }

    const result = updateUserPassword(username, password);

    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json(result);
  } catch (err) {
    logger.error('Failed to update user password', { error: err.message, username: req.params.username });
    return res.status(500).json({ success: false, message: 'Failed to update password.' });
  }
}

/**
 * DELETE /api/users/:username
 * Delete a user (admin only)
 */
function deleteUserHandler(req, res) {
  try {
    const { username } = req.params;

    // Don't allow deleting the current logged-in user
    const currentUser = req.user;
    if (currentUser && currentUser.username === username) {
      return res.status(400).json({
        success: false,
        message: 'You cannot delete your own account.'
      });
    }

    const result = deleteUser(username);

    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json(result);
  } catch (err) {
    logger.error('Failed to delete user', { error: err.message, username: req.params.username });
    return res.status(500).json({ success: false, message: 'Failed to delete user.' });
  }
}

module.exports = {
  getUsers,
  createUser,
  updateUserPasswordHandler,
  deleteUserHandler,
};
